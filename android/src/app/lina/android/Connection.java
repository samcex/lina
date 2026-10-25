package app.lina.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Only the phone's explicit LINA origin may receive LINA credentials: the SSH tunnel's loopback
 * address (http), the host's Tailscale address (https, *.ts.net), or an explicitly paired home
 * HTTPS address whose leaf certificate fingerprint was learned through authenticated pairing.
 */
public final class Connection {
  public final String url;
  public final String origin;
  /** SHA-256 of the explicitly paired home server leaf certificate, or empty for other routes. */
  public final String certificateSha256;
  private final String scheme;
  private final String host;
  private final int port;

  public Connection(String input) {
    this(input, "");
  }

  /** A pin is accepted only for an HTTPS private IPv4/explicit loopback home origin. */
  public Connection(String input, String certificateSha256) {
    this.certificateSha256 = normalizePin(certificateSha256);
    URI uri = uri(input == null ? "" : input.trim());
    String s = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
    String path = uri.getRawPath();
    boolean loopback = "http".equals(s) && ("127.0.0.1".equals(host) || "localhost".equals(host));
    boolean tailnet = "https".equals(s) && isTailnetHost(host);
    boolean home = "https".equals(s) && isHomeHost(host) && !this.certificateSha256.isEmpty();
    int p = "https".equals(s) && uri.getPort() == -1 ? 443 : uri.getPort();
    if (!(loopback || tailnet || home)
        || (!this.certificateSha256.isEmpty() && !home)
        || p < 1
        || p > 65535
        || uri.getRawUserInfo() != null
        || uri.getRawQuery() != null
        || !(path == null || path.isEmpty() || "/".equals(path))) {
      throw new IllegalArgumentException(
          "Use your Tailscale address https://NAME.ts.net:PORT/ (from `lina tailscale on`), "
              + "or http://127.0.0.1:PORT/#token=… through the SSH tunnel.");
    }
    scheme = s;
    port = p;
    origin = scheme + "://" + host + ("https".equals(scheme) && port == 443 ? "" : ":" + port) + "/";
    url = origin + (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
  }

  /** Signs in by Tailscale account: no token needed. */
  public boolean isTailnet() {
    return "https".equals(scheme) && isTailnetHost(host);
  }

  public boolean isHome() {
    return !certificateSha256.isEmpty();
  }

  public boolean allows(String candidate) {
    try {
      URI uri = uri(candidate);
      String s = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
      int p = uri.getPort() == -1 && "https".equals(s) ? 443 : uri.getPort();
      return scheme.equals(s)
          && host.equalsIgnoreCase(uri.getHost())
          && port == p
          && uri.getRawUserInfo() == null;
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  /** MagicDNS names: machine.tailnet.ts.net, plain DNS labels only. */
  static boolean isTailnetHost(String h) {
    if (!h.endsWith(".ts.net")) return false;
    String[] labels = h.split("\\.", -1);
    if (labels.length < 4) return false;
    for (String label : labels) {
      if (label.isEmpty() || label.length() > 63 || !label.matches("[a-z0-9]([a-z0-9-]*[a-z0-9])?"))
        return false;
    }
    return true;
  }

  static String normalizePin(String pin) {
    if (pin == null || pin.isEmpty()) return "";
    if (!pin.matches("[a-fA-F0-9]{64}"))
      throw new IllegalArgumentException("Home certificate fingerprint must contain 64 hexadecimal characters.");
    return pin.toLowerCase(Locale.ROOT);
  }

  /** Numeric RFC1918 addresses only: never DNS aliases, link-local, public, or CGNAT ranges. */
  static boolean isHomeHost(String host) {
    if ("localhost".equals(host) || "127.0.0.1".equals(host)) return true;
    String[] parts = host.split("\\.", -1);
    if (parts.length != 4) return false;
    int[] octets = new int[4];
    for (int i = 0; i < 4; i++) {
      if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
      octets[i] = Integer.parseInt(parts[i]);
      if (octets[i] > 255) return false;
    }
    return octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] == 192 && octets[1] == 168);
  }

  private static URI uri(String input) {
    try {
      return new URI(input);
    } catch (URISyntaxException e) {
      throw new IllegalArgumentException("Enter a valid LINA URL.");
    }
  }
}
