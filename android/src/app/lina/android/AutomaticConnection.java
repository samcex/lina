package app.lina.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import org.json.JSONObject;

/** Learns routes over an authenticated connection, then checks identity before each switch.
 * Only health/pairing reads are retried. Callers retain their immutable client for every write. */
final class AutomaticConnection {
  interface Listener {
    void connected(ApiClient client);
    void unavailable(String message);
  }

  private final SharedPreferences prefs;
  private final ConnectivityManager networks;
  private final Handler main = new Handler();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  // A stalled platform DNS lookup on Tailscale must not starve literal-IP home checks.
  // Bound the queues too: cancelled network checks cannot accumulate while DNS is stuck.
  private final ThreadPoolExecutor probes = probePool();
  private final ThreadPoolExecutor homeProbes = probePool();
  private final Listener listener;
  private final Connection bootstrap;
  private final String bootstrapToken;
  private ConnectionRoutes routes;
  private volatile boolean closed;
  private boolean checking, pending, resumed, registered;
  private int networkGeneration;
  private long pairedAt;
  private ApiClient active;
  private Network activeNetwork;

  private final ConnectivityManager.NetworkCallback changes =
      new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network n) { changed(); }
        @Override public void onLost(Network n) { changed(); }
        @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { changed(); }
        private void changed() { main.post(() -> {
          if (!closed && resumed) { networkGeneration++; retry(); }
        }); }
      };
  private final Runnable periodic = new Runnable() {
    public void run() {
      if (closed || !resumed) return;
      retry();
      main.postDelayed(this, 15000);
    }
  };

  AutomaticConnection(Context context, SharedPreferences prefs, Listener listener) {
    this.prefs = prefs;
    this.listener = listener;
    networks = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    bootstrap = new Connection(prefs.getString("origin", ""));
    bootstrapToken = prefs.getString("token", "");
    try {
      JSONObject saved = new JSONObject(prefs.getString("routes", "{}"));
      Connection source = new Connection(saved.getString("source"), saved.optString("sourcePin"));
      routes = parse(source, saved.getJSONObject("bundle"));
    } catch (Exception ignored) { prefs.edit().remove("routes").apply(); }
  }

  String description() {
    if (routes != null && routes.home != null)
      return "Automatic connection is ready: Home Wi-Fi first, Tailscale when away.";
    return "Connect over Tailscale once to save your home connection. On the PC: lina home on.";
  }

  void resume() {
    if (closed) return;
    resumed = true;
    if (!registered && networks != null) {
      // Listen to Wi-Fi as well as the default network: a VPN may be the default at home.
      networks.registerNetworkCallback(new NetworkRequest.Builder().clearCapabilities().build(), changes);
      registered = true;
    }
    main.removeCallbacks(periodic);
    main.post(periodic);
  }

  void pause() {
    resumed = false;
    main.removeCallbacks(periodic);
    if (registered) {
      networks.unregisterNetworkCallback(changes);
      registered = false;
    }
  }

  void retry() {
    if (closed) return;
    if (checking) { pending = true; return; }
    checking = true;
    final int epoch = networkGeneration;
    final Network wifi = wifi();
    final ConnectionRoutes known = routes;
    worker.execute(() -> {
      ApiClient chosen = null;
      Network chosenNetwork = null;
      JSONObject health = null;
      boolean signInExpired = false;
      ArrayList<Connection> candidates = new ArrayList<>();
      if (known != null)
        for (Connection route : known.candidates(wifi != null))
          if (!route.isHome() || wifi != null) candidates.add(route);
      boolean hasBootstrap = false;
      for (Connection route : candidates) if (sameRoute(route, bootstrap)) hasBootstrap = true;
      if (!hasBootstrap) candidates.add(bootstrap);
      for (Connection route : candidates) {
        if (closed) break;
        final Network network = route.isHome() ? wifi : null;
        String token = known != null && (route.isHome() || route.isTailnet())
            ? known.tokenFor(route) : bootstrapToken;
        ApiClient candidate = new ApiClient(route, token,
            url -> network == null ? (HttpURLConnection) url.openConnection()
                : (HttpURLConnection) network.openConnection(url), known == null ? "" : known.serverId);
        try {
          ThreadPoolExecutor pool = route.isHome() ? homeProbes : probes;
          Future<String> probe = pool.submit(() -> candidate.probe(1800));
          String response;
          try { response = probe.get(2300, TimeUnit.MILLISECONDS); }
          finally { probe.cancel(true); pool.purge(); }
          JSONObject identity = new JSONObject(response);
          if (!identity.optBoolean("ok") || (known != null && !known.matchesServer(identity.optString("serverId"))))
            continue;
          chosen = candidate;
          chosenNetwork = network;
          health = identity;
          break;
        } catch (Exception failure) {
          Throwable cause = failure instanceof java.util.concurrent.ExecutionException
              ? failure.getCause() : failure;
          if (cause instanceof ApiClient.ApiException && ((ApiClient.ApiException) cause).status == 401)
            signInExpired = true;
        }
      }
      final ApiClient selected = chosen;
      final Network selectedNetwork = chosenNetwork;
      final boolean authenticationFailed = signInExpired;
      main.post(() -> {
        if (closed) return;
        if (epoch != networkGeneration) return;
        if (selected != null) {
          if (active == null || !sameRoute(active.connection, selected.connection)
              || !active.expectedServerId.equals(selected.expectedServerId)
              || !sameNetwork(activeNetwork, selectedNetwork)) {
            active = selected;
            activeNetwork = selectedNetwork;
            listener.connected(selected);
          }
        } else {
          active = null;
          activeNetwork = null;
          listener.unavailable(authenticationFailed && known == null
              ? "Sign-in expired. Open Menu → Connection and paste the current LINA URL/token."
              : "Offline · Join home Wi-Fi or turn on Tailscale");
        }
      });
      // Pairing is allowed only through the original trusted SSH/Tailscale channel.
      // A home credential cannot reconfigure itself or introduce another destination.
      JSONObject learned = null;
      ConnectionRoutes learnedRoutes = null;
      if (chosen != null && !chosen.connection.isHome() && System.currentTimeMillis() - pairedAt > 60000) {
        pairedAt = System.currentTimeMillis();
        try {
          final ApiClient source = chosen;
          Future<String> pairing = probes.submit(() -> source.readConnectionProfile(2500));
          String response;
          try { response = pairing.get(3000, TimeUnit.MILLISECONDS); }
          finally { pairing.cancel(true); probes.purge(); }
          learned = new JSONObject(response);
          learnedRoutes = parse(source.connection, learned);
          if (!learnedRoutes.matchesServer(health.optString("serverId")))
            throw new IllegalArgumentException("Server identity changed while pairing");
        } catch (Exception ignored) { learned = null; learnedRoutes = null; }
      }
      final JSONObject bundle = learned;
      final ConnectionRoutes profile = learnedRoutes;
      main.post(() -> {
        if (closed) return;
        boolean changedProfile = profile != null && (routes == null
            || (profile.home != null && (routes.home == null || !sameRoute(routes.home, profile.home))));
        if (profile != null) {
          routes = profile;
          try {
            JSONObject saved = new JSONObject().put("source", selected.connection.origin)
                .put("sourcePin", selected.connection.certificateSha256).put("bundle", bundle);
            prefs.edit().putString("routes", saved.toString()).apply();
          } catch (Exception ignored) {}
        }
        checking = false;
        if (pending || changedProfile) { pending = false; retry(); }
      });
    });
  }

  private Network wifi() {
    if (networks != null)
      for (Network network : networks.getAllNetworks()) {
        NetworkCapabilities caps = networks.getNetworkCapabilities(network);
        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return network;
      }
    return null;
  }

  private static ThreadPoolExecutor probePool() {
    ThreadPoolExecutor pool = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
        new ArrayBlockingQueue<Runnable>(1));
    pool.allowCoreThreadTimeOut(true);
    return pool;
  }

  private static ConnectionRoutes parse(Connection source, JSONObject bundle) throws Exception {
    if (bundle.getInt("version") != 1) throw new IllegalArgumentException("Unknown connection profile");
    JSONObject home = bundle.optJSONObject("home");
    return ConnectionRoutes.provisioned(source, bundle.getString("serverId"),
        bundle.optString("tailnetUrl", null), home == null ? null : home.getString("url"),
        home == null ? null : home.getString("certificateSha256"), bundle.optString("token"));
  }

  static boolean sameRoute(Connection a, Connection b) {
    return a.origin.equals(b.origin) && a.certificateSha256.equals(b.certificateSha256);
  }

  private static boolean sameNetwork(Network a, Network b) { return a == null ? b == null : a.equals(b); }

  static String label(ApiClient client) {
    return (client.connection.isHome() ? "Home Wi-Fi" : client.connection.isTailnet() ? "Tailscale" : "SSH tunnel")
        + " · Connected";
  }

  String tokenFor(Connection route) {
    return route.isHome() ? routes.tokenFor(route)
        : route.isTailnet() ? "" : bootstrapToken;
  }

  void close() {
    closed = true;
    pause();
    main.removeCallbacksAndMessages(null);
    worker.shutdownNow();
    probes.shutdownNow();
    homeProbes.shutdownNow();
  }
}
