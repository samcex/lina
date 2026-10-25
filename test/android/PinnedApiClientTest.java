package app.lina.android;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsServer;
import com.sun.net.httpserver.HttpsConfigurator;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/** Actual self-signed TLS exercises the trust boundary before HTTP credentials can be transmitted. */
public final class PinnedApiClientTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) throws Exception {
    KeyStore keys = KeyStore.getInstance("PKCS12");
    try (FileInputStream in = new FileInputStream(args[0])) { keys.load(in, "test-password".toCharArray()); }
    KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
    managers.init(keys, "test-password".toCharArray());
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(managers.getKeyManagers(), null, null);
    StringBuilder fingerprint = new StringBuilder();
    for (byte value : MessageDigest.getInstance("SHA-256").digest(keys.getCertificate("home").getEncoded()))
      fingerprint.append(String.format("%02x", value & 255));
    String pin = fingerprint.toString();
    AtomicInteger requests = new AtomicInteger(), foreignRequests = new AtomicInteger(), opens = new AtomicInteger();
    HttpServer foreign = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    foreign.createContext("/", exchange -> { foreignRequests.incrementAndGet(); exchange.sendResponseHeaders(204, -1); exchange.close(); });
    HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.setHttpsConfigurator(new HttpsConfigurator(context));
    ExecutorService workers = Executors.newCachedThreadPool();
    server.setExecutor(workers);
    server.createContext("/api/", exchange -> {
      requests.incrementAndGet();
      try {
        check("Bearer secret-home-token".equals(exchange.getRequestHeaders().getFirst("Authorization")), "Home auth missing");
        String path = exchange.getRequestURI().getPath();
        ApiClient.read(exchange.getRequestBody(), 1024);
        if (path.equals("/api/redirect")) {
          exchange.getResponseHeaders().set("Location", "http://127.0.0.1:" + foreign.getAddress().getPort() + "/leak");
          exchange.sendResponseHeaders(302, -1);
        } else if (path.equals("/api/error")) {
          exchange.sendResponseHeaders(401, -1);
        } else if (path.equals("/api/disconnect")) {
          // Dropping an accepted mutation must not make the transport silently replay it.
          return;
        } else if (path.equals("/api/connection")) {
          exchange.sendResponseHeaders(200, 0);
          for (int i = 0; i < 100; i++) {
            exchange.getResponseBody().write(' ');
            exchange.getResponseBody().flush();
            try { Thread.sleep(25); } catch (InterruptedException interrupted) { return; }
          }
        } else {
          if (path.equals("/api/health")) {
            try { Thread.sleep(400); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
          }
          byte[] body = "{\"serverId\":\"same-server\"}".getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, body.length);
          exchange.getResponseBody().write(body);
        }
      } finally { exchange.close(); }
    });
    server.start(); foreign.start();
    try {
      String origin = "https://127.0.0.1:" + server.getAddress().getPort() + "/";
      ApiClient good = new ApiClient(new Connection(origin, pin), "secret-home-token", url -> {
        opens.incrementAndGet(); return (java.net.HttpURLConnection) url.openConnection();
      });
      check(good.request("POST", "/api/message", "{}").contains("same-server"), "Pinned TLS failed");
      check(opens.get() == 1, "Connection opener ignored");
      int before = requests.get();
      String wrongPin = (pin.charAt(0) == '0' ? "1" : "0") + pin.substring(1);
      ApiClient wrong = new ApiClient(new Connection(origin, wrongPin), "secret-home-token");
      try { wrong.request("POST", "/api/message", "secret-mutation"); throw new AssertionError("Wrong certificate accepted"); }
      catch (IOException expected) { check(!expected.toString().contains("secret-home-token"), "Token leaked in error"); }
      check(requests.get() == before, "Wrong pin sent HTTP credentials or body");
      for (String method : new String[] {"GET", "POST", "DELETE"}) {
        before = requests.get();
        try { good.request(method, "/api/redirect", null); throw new AssertionError("TLS redirect followed"); }
        catch (ApiClient.ApiException expected) { check(expected.status == 302, "Redirect status changed"); }
        check(requests.get() == before + 1 && foreignRequests.get() == 0, "Redirect retried or leaked token");
      }
      for (String method : new String[] {"POST", "PUT", "DELETE"}) {
        before = requests.get();
        try { good.request(method, "/api/error", null); throw new AssertionError("401 succeeded"); }
        catch (ApiClient.ApiException expected) { check(expected.status == 401, "401 status changed"); }
        check(requests.get() == before + 1, "Bodyless mutation retried");
        before = requests.get();
        try { good.request(method, "/api/disconnect", "{}"); throw new AssertionError("Broken mutation succeeded"); }
        catch (IOException expected) { }
        check(requests.get() == before + 1, "Interrupted mutation retried");
      }
      long start = System.nanoTime();
      try { good.probe(150); throw new AssertionError("Probe timeout ignored"); }
      catch (IOException expected) { }
      check((System.nanoTime() - start) / 1000000 < 1000, "Probe did not stop promptly");
      start = System.nanoTime();
      try { good.readConnectionProfile(250); throw new AssertionError("TLS trickle escaped deadline"); }
      catch (IOException expected) { }
      check((System.nanoTime() - start) / 1000000 < 1000, "TLS trickle kept probe worker occupied");
      check(good.request("GET", "/api/recovered", null).contains("same-server"), "Deadline broke later TLS requests");
      ApiClient changedOrigin = new ApiClient(new Connection(origin, pin), "secret-home-token",
        url -> (java.net.HttpURLConnection) new java.net.URL("http://127.0.0.1:" + foreign.getAddress().getPort() + "/").openConnection());
      try { changedOrigin.request("GET", "/api/health", null); throw new AssertionError("Opener origin substitution allowed"); }
      catch (IOException expected) { }
      check(foreignRequests.get() == 0, "Opener leaked credentials to foreign origin");
      System.out.println("Android pinned TLS transport passed");
    } finally { server.stop(0); foreign.stop(0); workers.shutdownNow(); }
  }
}
