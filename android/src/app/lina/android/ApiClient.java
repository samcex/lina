package app.lina.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** One immutable authenticated connection. Never follows redirects or retries a mutation. */
public final class ApiClient {
  public final Connection connection;
  public final String expectedServerId;
  private final String token;
  private final ConnectionOpener opener;
  private final SSLSocketFactory pinnedSockets;

  /** Android callers can bind a route to a Wi-Fi Network without coupling this class to Android. */
  public interface ConnectionOpener {
    HttpURLConnection open(URL url) throws IOException;
  }

  public ApiClient(Connection connection, String token) {
    this(connection, token, url -> (HttpURLConnection) url.openConnection());
  }

  public ApiClient(Connection connection, String token, ConnectionOpener opener) {
    this(connection, token, opener, "");
  }

  public ApiClient(Connection connection, String token, ConnectionOpener opener, String expectedServerId) {
    if (connection == null || opener == null) throw new IllegalArgumentException("Missing connection");
    this.connection = connection;
    this.token = token == null ? "" : token;
    if (this.token.indexOf('\r') >= 0 || this.token.indexOf('\n') >= 0)
      throw new IllegalArgumentException("Invalid connection token");
    this.opener = opener;
    this.expectedServerId = expectedServerId == null ? "" : expectedServerId;
    if (this.expectedServerId.length() > 256 || containsControl(this.expectedServerId))
      throw new IllegalArgumentException("Invalid expected server identity");
    pinnedSockets = connection.isHome() ? pinnedSockets(connection.certificateSha256) : null;
  }

  /** A read-only health check; the caller verifies serverId before switching the active route. */
  public String probe(int timeoutMs) throws IOException {
    return deadlineRead("/api/health", timeoutMs);
  }

  /** The authenticated pairing bundle has the same hard deadline and 32 KiB cap as health. */
  public String readConnectionProfile(int timeoutMs) throws IOException {
    return deadlineRead("/api/connection", timeoutMs);
  }

  private String deadlineRead(String path, int timeoutMs) throws IOException {
    if (timeoutMs < 2) throw new IllegalArgumentException("Read timeout must be at least 2 ms");
    try (Deadline deadline = new Deadline(timeoutMs)) {
      return request("GET", path, null, "application/json", null,
          timeoutMs / 2, timeoutMs - timeoutMs / 2, 32 * 1024, deadline);
    }
  }

  public String request(String method, String path, String json) throws IOException {
    return request(
        method,
        path,
        json == null ? null : json.getBytes(StandardCharsets.UTF_8),
        "application/json",
        null);
  }

  public String request(String method, String path, byte[] bytes, String mime, String filename)
      throws IOException {
    return request(method, path, bytes, mime, filename, 8000,
        path != null && path.startsWith("/api/models") ? 120000 : 15000, 16 * 1024 * 1024, null);
  }

  private String request(String method, String path, byte[] bytes, String mime, String filename,
      int connectTimeout, int readTimeout, int responseLimit, Deadline deadline) throws IOException {
    if (path == null || !path.startsWith("/api/") || path.contains("\r") || path.contains("\n"))
      throw new IOException("Invalid API path");
    String address = connection.origin.substring(0, connection.origin.length() - 1) + path;
    if (!connection.allows(address)) throw new IOException("Invalid connection origin");
    HttpURLConnection http = opener.open(new URL(address));
    try {
      if (deadline != null) deadline.attach(http);
      if (!connection.allows(http.getURL().toExternalForm()))
        throw new IOException("Connection opener changed the origin");
      if (pinnedSockets != null) {
        if (!(http instanceof HttpsURLConnection)) throw new IOException("Home connection requires TLS");
        HttpsURLConnection tls = (HttpsURLConnection) http;
        tls.setSSLSocketFactory(pinnedSockets);
        // A paired leaf certificate is the explicit hostname identity for numeric home addresses.
        // The trust manager rejects a mismatch during the handshake, before HTTP headers/body.
        tls.setHostnameVerifier((hostname, session) -> {
          try {
            return hostname.equalsIgnoreCase(new URL(connection.origin).getHost())
                && matchesPin((X509Certificate) session.getPeerCertificates()[0], connection.certificateSha256);
          } catch (Exception rejected) { return false; }
        });
      }
      http.setConnectTimeout(connectTimeout);
      http.setReadTimeout(readTimeout);
      http.setInstanceFollowRedirects(false);
      http.setRequestMethod(method);
      if (bytes == null && !"GET".equals(method) && !"HEAD".equals(method)) {
        // Streaming mode also prevents HttpURLConnection replaying a bodyless mutation after auth
        // challenges, redirects, or an interrupted keep-alive connection.
        http.setDoOutput(true);
        http.setFixedLengthStreamingMode(0);
      }
      http.setRequestProperty("Accept", "application/json");
      if (!expectedServerId.isEmpty()) http.setRequestProperty("X-Lina-Server-Id", expectedServerId);
      if (deadline != null) deadline.check();
      if (!token.isEmpty()) http.setRequestProperty("Authorization", "Bearer " + token);
      if (bytes != null) {
        http.setDoOutput(true);
        http.setFixedLengthStreamingMode(bytes.length);
        http.setRequestProperty("Content-Type", mime);
        if (filename != null) http.setRequestProperty("x-filename", filename);
        try (java.io.OutputStream out = http.getOutputStream()) {
          out.write(bytes);
        }
      }
      int status = http.getResponseCode();
      if (deadline != null) deadline.check();
      InputStream stream = status < 400 ? http.getInputStream() : http.getErrorStream();
      String body =
          stream == null ? "" : new String(read(stream, responseLimit, deadline), StandardCharsets.UTF_8);
      if (deadline != null) deadline.check();
      if (status < 200 || status >= 300) throw new ApiException(status, body);
      return body;
    } finally {
      http.disconnect();
    }
  }

  private static boolean matchesPin(X509Certificate certificate, String pin)
      throws GeneralSecurityException {
    byte[] expected = new byte[32];
    for (int i = 0; i < expected.length; i++)
      expected[i] = (byte) Integer.parseInt(pin.substring(i * 2, i * 2 + 2), 16);
    return MessageDigest.isEqual(expected, MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
  }

  private static boolean containsControl(String value) {
    for (int i = 0; i < value.length(); i++)
      if (Character.isISOControl(value.charAt(i))) return true;
    return false;
  }

  private static SSLSocketFactory pinnedSockets(String pin) {
    try {
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(null, new TrustManager[] { new X509TrustManager() {
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
          throw new CertificateException("Client certificates are not supported");
        }
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
          try {
            if (chain == null || chain.length == 0 || !matchesPin(chain[0], pin))
              throw new CertificateException("Home certificate fingerprint changed");
            chain[0].checkValidity();
          } catch (GeneralSecurityException rejected) {
            throw new CertificateException("Home certificate fingerprint could not be verified", rejected);
          }
        }
      } }, null);
      return context.getSocketFactory();
    } catch (GeneralSecurityException unavailable) {
      throw new IllegalStateException("TLS is unavailable", unavailable);
    }
  }

  public static byte[] read(InputStream input, int limit) throws IOException {
    return read(input, limit, null);
  }

  private static byte[] read(InputStream input, int limit, Deadline deadline) throws IOException {
    try (InputStream in = input;
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] chunk = new byte[8192];
      int n;
      while (true) {
        if (deadline != null) deadline.check();
        n = in.read(chunk);
        if (deadline != null) deadline.check();
        if (n == -1) break;
        if (out.size() + n > limit)
          throw new IOException(
              "File or response is too large (maximum "
                  + (limit >= 1024 * 1024 ? limit / 1024 / 1024 + " MB"
                      : limit >= 1024 ? limit / 1024 + " KB" : limit + " bytes") + ").");
        out.write(chunk, 0, n);
      }
      return out.toByteArray();
    }
  }

  /** A separate per-read watchdog closes the socket even when bytes keep resetting SO_TIMEOUT.
   * DNS inside the platform resolver may ignore cancellation; an opener returning after expiry is
   * rejected before any credential is configured. This is never used for mutations. */
  private static final class Deadline implements AutoCloseable {
    private final long end;
    private final Thread watchdog;
    private HttpURLConnection http;
    private boolean done;
    private volatile boolean expired;

    Deadline(int timeoutMs) {
      end = System.nanoTime() + timeoutMs * 1000000L;
      watchdog = new Thread(() -> {
        HttpURLConnection cancel;
        synchronized (this) {
          while (!done) {
            long remaining = end - System.nanoTime();
            if (remaining <= 0) break;
            try { wait(remaining / 1000000L, (int) (remaining % 1000000L)); }
            catch (InterruptedException stopped) { return; }
          }
          if (done) return;
          expired = true;
          cancel = http;
        }
        if (cancel != null) cancel.disconnect();
      }, "lina-read-deadline");
      watchdog.setDaemon(true);
      watchdog.start();
    }

    synchronized void attach(HttpURLConnection connection) throws IOException {
      http = connection;
      check();
    }

    void check() throws SocketTimeoutException {
      if (expired || System.nanoTime() >= end || Thread.currentThread().isInterrupted())
        throw new SocketTimeoutException("Connection check deadline exceeded");
    }

    public synchronized void close() {
      done = true;
      notifyAll();
      watchdog.interrupt();
    }
  }

  public static final class ApiException extends IOException {
    public final int status;
    public final String body;

    ApiException(int status, String body) {
      super("HTTP " + status);
      this.status = status;
      this.body = body;
    }
  }
}
