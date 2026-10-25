package app.lina.android;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public final class DeadlineApiClientTest {
  private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }

  public static void main(String[] args) throws Exception {
    AtomicBoolean trickle = new AtomicBoolean(true), oversized = new AtomicBoolean(false);
    AtomicInteger requests = new AtomicInteger(), disconnected = new AtomicInteger();
    CountDownLatch started = new CountDownLatch(2);
    ExecutorService serverThreads = Executors.newCachedThreadPool(), probes = Executors.newFixedThreadPool(2);
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.setExecutor(serverThreads);
    server.createContext("/api/", exchange -> {
      requests.incrementAndGet();
      try {
        check("Bearer deadline-test-token".equals(exchange.getRequestHeaders().getFirst("Authorization")), "Token missing");
        check("expected-server".equals(exchange.getRequestHeaders().getFirst("X-Lina-Server-Id")), "Identity header missing");
        if (trickle.get()) {
          exchange.sendResponseHeaders(200, 0);
          started.countDown();
          // Frequent bytes prevent the socket inactivity timeout from ever firing.
          for (int i = 0; i < 200; i++) {
            exchange.getResponseBody().write(' ');
            exchange.getResponseBody().flush();
            try { Thread.sleep(25); } catch (InterruptedException interrupted) { return; }
          }
        } else {
          byte[] body = oversized.get() ? new byte[32769] : "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, body.length);
          exchange.getResponseBody().write(body);
        }
      } catch (IOException closed) { disconnected.incrementAndGet(); }
      finally { exchange.close(); }
    });
    server.start();
    try {
      Connection origin = new Connection("http://127.0.0.1:" + server.getAddress().getPort());
      ApiClient client = new ApiClient(origin, "deadline-test-token", url -> (HttpURLConnection) url.openConnection(), "expected-server");
      check(client.expectedServerId.equals("expected-server"), "Expected identity not exposed");
      long beginning = System.nanoTime();
      Future<Boolean> health = probes.submit(() -> { try { client.probe(400); return false; } catch (IOException expected) { return true; } });
      Future<Boolean> profile = probes.submit(() -> { try { client.readConnectionProfile(400); return false; } catch (IOException expected) { return true; } });
      check(started.await(1, TimeUnit.SECONDS), "Both probes did not start");
      check(health.get(1200, TimeUnit.MILLISECONDS) && profile.get(1200, TimeUnit.MILLISECONDS), "Trickle escaped deadline");
      check((System.nanoTime() - beginning) / 1000000L < 1200, "Response inactivity replaced total deadline");
      trickle.set(false);
      Future<String> recovery = probes.submit(() -> client.probe(800));
      check(recovery.get(1200, TimeUnit.MILLISECONDS).contains("true"), "Timed-out requests exhausted probe workers");
      long until = System.nanoTime() + 1000000000L;
      while (disconnected.get() < 2 && System.nanoTime() < until) Thread.sleep(20);
      check(disconnected.get() >= 2, "Deadline did not disconnect sockets");
      oversized.set(true);
      for (boolean pairing : new boolean[] {false, true}) {
        try {
          if (pairing) client.readConnectionProfile(800); else client.probe(800);
          throw new AssertionError("Oversized control response accepted");
        } catch (IOException expected) { check(expected.getMessage().contains("large"), "Wrong size failure"); }
      }
      oversized.set(false);
      int before = requests.get();
      ApiClient lateOpener = new ApiClient(origin, "deadline-test-token", url -> {
        try { Thread.sleep(250); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        return (HttpURLConnection) url.openConnection();
      }, "expected-server");
      try { lateOpener.probe(75); throw new AssertionError("Late opener allowed credentials"); }
      catch (IOException expected) { }
      check(requests.get() == before, "Expired opener sent credentials later");
      for (String identity : new String[] {"bad\ridentity", "bad\nidentity", "bad\u0000identity", "bad\u0085identity"}) {
        try { new ApiClient(origin, "", url -> (HttpURLConnection) url.openConnection(), identity); throw new AssertionError("Control accepted in identity"); }
        catch (IllegalArgumentException expected) { }
      }
      System.out.println("Android control read deadlines passed");
    } finally { server.stop(0); probes.shutdownNow(); serverThreads.shutdownNow(); }
  }
}
