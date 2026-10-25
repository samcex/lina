package app.lina.android;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

/** Real HTTP transport tests independent of Android, WebView, and provider quota. */
public final class ApiClientTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        AtomicInteger requests = new AtomicInteger();
        AtomicInteger foreignRequests = new AtomicInteger();
        HttpServer foreign = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        foreign.createContext("/", exchange -> {
            foreignRequests.incrementAndGet();
            exchange.sendResponseHeaders(200, 0);
            exchange.close();
        });
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/", exchange -> {
            requests.incrementAndGet();
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/api/redirect")) {
                exchange.getResponseHeaders().set("Location", "http://127.0.0.1:" + foreign.getAddress().getPort() + "/leak");
                exchange.sendResponseHeaders(302, -1);
            } else if (path.equals("/api/error") || path.equals("/api/bad")) {
                byte[] body = "{\"error\":\"Unauthorized\",\"hint\":\"Reconnect\"}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(path.equals("/api/error") ? 401 : 400, body.length);
                exchange.getResponseBody().write(body);
            } else if (path.equals("/api/empty")) {
                check("DELETE".equals(exchange.getRequestMethod()), "DELETE method changed");
                exchange.sendResponseHeaders(204, -1);
            } else {
                check("Bearer private-test-token".equals(exchange.getRequestHeaders().getFirst("Authorization")), "Missing auth");
                check("application/json".equals(exchange.getRequestHeaders().getFirst("Accept")), "Missing JSON accept");
                byte[] input = ApiClient.read(exchange.getRequestBody(), 1024);
                String output = exchange.getRequestMethod() + ":" + new String(input, StandardCharsets.UTF_8);
                if (path.equals("/api/upload")) {
                    check("text/plain".equals(exchange.getRequestHeaders().getFirst("Content-Type")), "Upload MIME changed");
                    check("notes%20file.txt".equals(exchange.getRequestHeaders().getFirst("x-filename")), "Upload filename changed");
                }
                byte[] body = output.getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            }
            exchange.close();
        });
        server.start(); foreign.start();
        try {
            Connection connection = new Connection("http://127.0.0.1:" + server.getAddress().getPort() + "/");
            ApiClient client = new ApiClient(connection, "private-test-token");
            check(client.request("GET", "/api/health", null).equals("GET:"), "GET failed");
            check(client.request("POST", "/api/message", "{\"text\":\"Grüezi\"}").equals("POST:{\"text\":\"Grüezi\"}"), "UTF-8 JSON changed");
            check(client.request("PUT", "/api/settings", "{}").equals("PUT:{}"), "PUT failed");
            check(client.request("POST", "/api/upload", "hello".getBytes(StandardCharsets.UTF_8), "text/plain", "notes%20file.txt").equals("POST:hello"), "Upload changed");
            check(client.request("DELETE", "/api/empty", null).isEmpty(), "204 response failed");
            try {
                client.request("GET", "/api/redirect", null);
                throw new AssertionError("Redirect silently followed");
            } catch (ApiClient.ApiException expected) {
                check(expected.status == 302, "Redirect status changed");
            }
            check(foreignRequests.get() == 0, "Credentials sent to redirect destination");
            int before = requests.get();
            try {
                client.request("POST", "/api/error", "{}");
                throw new AssertionError("Unauthorized mutation succeeded");
            } catch (ApiClient.ApiException expected) {
                // Some JDKs hide the 401 body for fixed-length streaming requests;
                // the native UI diagnoses expired credentials from status alone.
                check(expected.status == 401, "Authentication status lost");
                check(!expected.getMessage().contains("private-test-token"), "Token leaked in exception");
            }
            check(requests.get() == before + 1, "Mutation was retried");
            try {
                client.request("POST", "/api/bad", "{}");
                throw new AssertionError("Bad request succeeded");
            } catch (ApiClient.ApiException expected) {
                check(expected.status == 400 && expected.body.contains("Reconnect"), "API error information lost");
            }
            before = requests.get();
            for (String path : new String[] {"http://foreign/api/", "//foreign/api/", "/outside", "/api/health\r\nHeader: value"}) {
                try { client.request("GET", path, null); throw new AssertionError("Invalid path accepted"); }
                catch (IOException expected) { /* rejected before network */ }
            }
            check(requests.get() == before, "Invalid path reached network");
            check(ApiClient.read(new ByteArrayInputStream(new byte[8]), 8).length == 8, "Exact size cap failed");
            try { ApiClient.read(new ByteArrayInputStream(new byte[9]), 8); throw new AssertionError("Size cap ignored"); }
            catch (IOException expected) { /* over-limit input rejected */ }
            System.out.println("Android API transport passed");
        } finally {
            server.stop(0); foreign.stop(0);
        }
    }
}
