package app.lina.android;

/** An immutable bundle obtained only over an already authenticated connection. JSON lives in the UI. */
public final class ConnectionRoutes {
  public final String serverId;
  public final Connection tailnet;
  public final Connection home;
  public final String homeToken;

  private ConnectionRoutes(String serverId, Connection tailnet, Connection home, String homeToken) {
    this.serverId = serverId;
    this.tailnet = tailnet;
    this.home = home;
    this.homeToken = homeToken;
  }

  /**
   * Call only after successfully authenticating the bundle request and comparing its serverId to
   * health.serverId. Persist the authenticated source with the bundle, never a fresh intent URL.
   */
  public static ConnectionRoutes provisioned(Connection authenticatedSource, String serverId,
      String tailnetUrl, String homeUrl, String certificateSha256, String homeToken) {
    if (authenticatedSource == null || serverId == null || serverId.trim().isEmpty()
        || serverId.length() > 256 || !serverId.equals(serverId.trim())
        || serverId.matches("(?s).*[\\p{Cntrl}].*"))
      throw new IllegalArgumentException("Invalid server identity");
    Connection tailnet = absent(tailnetUrl) ? null : new Connection(tailnetUrl);
    if (tailnet != null && (!tailnet.isTailnet() || !tailnet.url.equals(tailnet.origin)))
      throw new IllegalArgumentException("Invalid Tailscale route");
    Connection home = absent(homeUrl) ? null : new Connection(homeUrl, certificateSha256);
    if (home != null && (!home.isHome() || !home.url.equals(home.origin)))
      throw new IllegalArgumentException("Invalid home route");
    if (home == null && !absent(certificateSha256))
      throw new IllegalArgumentException("Home certificate has no route");
    if (tailnet == null && home == null) throw new IllegalArgumentException("No connection routes");
    String token = homeToken == null ? "" : homeToken;
    if ((home != null && token.isEmpty()) || token.matches("(?s).*[\\p{Cntrl}].*"))
      throw new IllegalArgumentException("Invalid home connection token");
    if (authenticatedSource.isTailnet() && !same(authenticatedSource, tailnet))
      throw new IllegalArgumentException("Tailscale route changed during pairing");
    if (authenticatedSource.isHome() && !same(authenticatedSource, home))
      throw new IllegalArgumentException("Home identity changed during pairing");
    return new ConnectionRoutes(serverId, tailnet, home, home == null ? "" : token);
  }

  public Connection[] candidates(boolean preferHome) {
    if (tailnet == null) return new Connection[] { home };
    if (home == null) return new Connection[] { tailnet };
    return preferHome ? new Connection[] { home, tailnet } : new Connection[] { tailnet, home };
  }

  /** The durable home credential never goes to Tailscale or a different home certificate/origin. */
  public String tokenFor(Connection route) {
    if (same(route, home)) return homeToken;
    if (same(route, tailnet)) return "";
    throw new IllegalArgumentException("Unknown connection route");
  }

  public boolean matchesServer(String candidateServerId) { return serverId.equals(candidateServerId); }

  private static boolean same(Connection a, Connection b) {
    return a != null && b != null && a.origin.equals(b.origin)
        && a.certificateSha256.equals(b.certificateSha256);
  }

  private static boolean absent(String value) { return value == null || value.isEmpty(); }
}
