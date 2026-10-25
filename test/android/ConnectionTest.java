package app.lina.android;

/** Plain JVM tests keep the URL boundary testable without an emulator or test libraries. */
public final class ConnectionTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    public static void main(String[] args) {
        Connection connection = new Connection("  http://127.0.0.1:7077/#token=secret%26value&session=ses1  ");
        check(connection.origin.equals("http://127.0.0.1:7077/"));
        check(connection.url.equals("http://127.0.0.1:7077/#token=secret%26value&session=ses1"));
        check(!connection.origin.contains("secret"));
        check(connection.allows("http://127.0.0.1:7077/api/health"));
        check(connection.allows("http://127.0.0.1:7077/ws?token=secret"));
        check(connection.allows("http://127.0.0.1:7077/assets/main.js"));
        check(new Connection("http://localhost:12345").origin.equals("http://localhost:12345/"));
        check(new Connection("http://LOCALHOST:7077/#s=ses").url.equals("http://localhost:7077/#s=ses"));
        Connection tailnet = new Connection("https://Developer.example.ts.net:7077/");
        check(tailnet.isTailnet() && !connection.isTailnet());
        check(tailnet.origin.equals("https://developer.example.ts.net:7077/"));
        check(tailnet.url.equals("https://developer.example.ts.net:7077/"));
        check(tailnet.allows("https://developer.example.ts.net:7077/api/health"));
        check(new Connection("https://developer.example.ts.net").origin.equals("https://developer.example.ts.net/"));
        check(new Connection("https://developer.example.ts.net:443/").allows("https://developer.example.ts.net/assets/a.js"));
        for (String input : new String[] {"http://developer.example.ts.net:7077/", "https://developer.example.ts.net:7078/",
                "https://other.example.ts.net:7077/", "https://developer.example.ts.net.evil.com:7077/",
                "https://user@developer.example.ts.net:7077/"}) {
            if (tailnet.allows(input)) throw new AssertionError("Tailnet connection allowed foreign origin: " + input);
        }
        String[] rejected = {
            "https://127.0.0.1:7077/", "http://developer.example.ts.net:7077/", "https://ts.net/", "https://example.ts.net/",
            "https://developer.example.ts.net.evil.com/", "https://evil.com/.ts.net", "https://invalid_host.example.ts.net/",
            "https://-x.example.ts.net/", "https://developer.example.ts.net:7077/path", "https://developer.example.ts.net/?q=1",
            "https://user@developer.example.ts.net/", "https://developer.example.ts.net:0/", "http://example.com:7077/", "http://192.168.1.1:7077/",
            "http://localhost.evil:7077/", "http://127.0.0.1.evil:7077/", "http://127.0.0.2:7077/",
            "http://user@127.0.0.1:7077/", "http://127.0.0.1:7077@evil:7077/",
            "http://127.0.0.1/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/",
            "http://127.0.0.1:7077/api/health", "http://127.0.0.1:7077/?token=secret",
            "file:///etc/passwd", "javascript:alert(1)", "intent://localhost:7077/", "not a URL",
            "http://%31%32%37.0.0.1:7077/", "http://[::1]:7077/"
        };
        for (String input : rejected) {
            boolean failed = false;
            try { new Connection(input); } catch (IllegalArgumentException expected) { failed = true; }
            if (!failed) throw new AssertionError("Accepted forbidden connection: " + input);
        }
        for (String input : new String[] {"http://localhost:7077/", "http://127.0.0.1:7078/",
                "http://evil:7077/", "https://127.0.0.1:7077/", "file:///tmp/a", "about:blank",
                "http://user@127.0.0.1:7077/", "//127.0.0.1:7077/"}) {
            if (connection.allows(input)) throw new AssertionError("Allowed foreign origin: " + input);
        }
        String pin = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        for (String host : new String[] {"10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.100", "127.0.0.1", "localhost"}) {
            Connection home = new Connection("https://" + host + ":7443", pin.toUpperCase());
            check(home.isHome() && !home.isTailnet());
            check(home.certificateSha256.equals(pin));
            check(home.allows(home.origin + "api/health"));
            check(!home.allows("http://" + host + ":7443/api/health"));
        }
        for (String host : new String[] {"172.15.255.255", "172.32.0.1", "192.169.1.1", "100.64.1.1", "169.254.1.1", "8.8.8.8", "192.168.01.1", "192.168.1.256", "home.local", "127.0.0.2", "[::1]", "evil.com"}) {
            rejectPinned("https://" + host + "/", pin);
        }
        for (String badPin : new String[] {"", "a", pin + "a", pin.substring(1), pin.replace('a', 'z'), " " + pin})
            rejectPinned("https://192.168.1.100/", badPin);
        rejectPinned("http://192.168.1.100:7443/", pin);
        rejectPinned("http://127.0.0.1:7443/", pin);
        rejectPinned(tailnet.origin, pin);
        rejectPinned("https://192.168.1.100:7443/path", pin);
        rejectPinned("https://user@192.168.1.100:7443/", pin);
        ConnectionRoutes routes = ConnectionRoutes.provisioned(tailnet, "same-server", tailnet.origin,
            "https://192.168.1.100:7443", pin, "private-home-token");
        check(routes.candidates(true)[0] == routes.home && routes.candidates(false)[0] == routes.tailnet);
        check(routes.tokenFor(routes.tailnet).isEmpty() && routes.tokenFor(routes.home).equals("private-home-token"));
        check(routes.matchesServer("same-server") && !routes.matchesServer("other-server"));
        ConnectionRoutes.provisioned(connection, "same-server", null, routes.home.origin, pin, "home-token");
        ConnectionRoutes.provisioned(routes.home, "same-server", null, routes.home.origin, pin, "home-token");
        try { routes.tokenFor(new Connection("https://192.168.1.101:7443", pin)); throw new AssertionError("Foreign route got token"); }
        catch (IllegalArgumentException expected) { }
        try { routes.tokenFor(new Connection(routes.home.origin, pin.replace('a', 'b'))); throw new AssertionError("Changed certificate got token"); }
        catch (IllegalArgumentException expected) { }
        try { ConnectionRoutes.provisioned(tailnet, "same-server", "https://evil.example.ts.net", routes.home.origin, pin, "token"); throw new AssertionError("Foreign Tailnet provisioned"); }
        catch (IllegalArgumentException expected) { }
        try { ConnectionRoutes.provisioned(routes.home, "same-server", null, routes.home.origin, pin.replace('a', 'b'), "token"); throw new AssertionError("Changed home pin provisioned"); }
        catch (IllegalArgumentException expected) { }
        try { ConnectionRoutes.provisioned(connection, "same-server", null, routes.home.origin, pin, ""); throw new AssertionError("Home route without token provisioned"); }
        catch (IllegalArgumentException expected) { }
        System.out.println("Android connection policy passed");
    }

    private static void rejectPinned(String url, String pin) {
        try { new Connection(url, pin); throw new AssertionError("Invalid pinned route accepted: " + url); }
        catch (IllegalArgumentException expected) { }
    }
}
