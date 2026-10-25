package app.lina.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.SslErrorHandler;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

public final class AdvancedWebActivity extends Activity {
  private static final int PICK_FILE = 1;
  private WebView web;
  private TextView status;
  private SharedPreferences preferences;
  private volatile Connection connection;
  private ValueCallback<Uri[]> fileCallback;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    preferences = getSharedPreferences("web_connection", MODE_PRIVATE);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(13, 15, 23));
    root.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets padding =
                insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
          } else {
            view.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom());
          }
          return Build.VERSION.SDK_INT >= 30
              ? WindowInsets.CONSUMED
              : insets.consumeSystemWindowInsets();
        });
    LinearLayout bar = new LinearLayout(this);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    TextView title = new TextView(this);
    title.setText("LINA");
    title.setTextSize(20);
    title.setTextColor(Color.rgb(198, 189, 255));
    title.setPadding(dp(16), 0, 0, 0);
    bar.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
    Button reload = new Button(this);
    reload.setText("Reload");
    reload.setOnClickListener(
        v -> {
          if (connection != null) {
            status.setVisibility(View.GONE);
            web.reload();
          }
        });
    bar.addView(reload);
    Button settings = new Button(this);
    settings.setText("Connection");
    settings.setOnClickListener(v -> showConnection());
    bar.addView(settings);
    root.addView(bar);

    FrameLayout content = new FrameLayout(this);
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(13, 15, 23));
    content.addView(web, new FrameLayout.LayoutParams(-1, -1));
    status = new TextView(this);
    status.setTextColor(Color.rgb(232, 234, 243));
    status.setTextSize(17);
    status.setGravity(Gravity.CENTER);
    status.setPadding(dp(24), dp(24), dp(24), dp(24));
    status.setBackgroundColor(Color.rgb(13, 15, 23));
    content.addView(status, new FrameLayout.LayoutParams(-1, -1));
    root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher()
          .registerOnBackInvokedCallback(
              android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
    }

    WebSettings config = web.getSettings();
    config.setJavaScriptEnabled(true);
    // Keep localhost/tailnet localStorage for installed-app relaunches. The token grants
    // full control; backup is disabled and both UIs offer a Forget action.
    config.setDomStorageEnabled(true);
    config.setAllowFileAccess(false);
    config.setAllowContentAccess(false);
    config.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    config.setJavaScriptCanOpenWindowsAutomatically(false);
    config.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (connection != null && connection.allows(request.getUrl().toString())) return false;
            Toast.makeText(
                    AdvancedWebActivity.this,
                    "Only this LINA connection is allowed.",
                    Toast.LENGTH_SHORT)
                .show();
            return true;
          }

          @Override
          public WebResourceResponse shouldInterceptRequest(
              WebView view, WebResourceRequest request) {
            Connection current = connection;
            if (current != null && current.allows(request.getUrl().toString())) return null;
            return new WebResourceResponse(
                "text/plain", "UTF-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
          }

          @Override
          public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            Connection trusted = connection;
            try {
              // The unexported activity receives this pin from native authenticated pairing.
              // Never accept another certificate, redirect origin, or an expired paired leaf.
              if (trusted == null || !trusted.isHome() || !trusted.allows(error.getUrl()))
                throw new IllegalArgumentException("Unpaired TLS connection");
              byte[] der = SslCertificate.saveState(error.getCertificate()).getByteArray("x509-certificate");
              X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                  .generateCertificate(new ByteArrayInputStream(der));
              cert.checkValidity();
              byte[] hash = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
              StringBuilder pin = new StringBuilder();
              for (byte b : hash) pin.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
              if (!trusted.certificateSha256.equals(pin.toString()))
                throw new IllegalArgumentException("Home certificate changed");
              handler.proceed();
            } catch (Exception rejected) {
              handler.cancel();
              showStatus("Could not verify this LINA server. Return to the native app to reconnect.");
            }
          }

          @Override
          public void onReceivedError(
              WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Connection current = connection;
            showStatus(
                current != null && current.isTailnet()
                    ? "LINA is unreachable. Turn on Tailscale on this phone and check that the PC"
                        + " is online, then tap Reload."
                    : current != null && current.isHome()
                        ? "LINA is unreachable. Check home Wi-Fi, or return to the native app to switch to Tailscale."
                        : "LINA is unreachable. Start the SSH tunnel in Termux, then tap Reload or"
                        + " Connection.");
          }
        });
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage message) {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                && message.message().contains("SyntaxError")) {
              showStatus(
                  "Update Android System WebView or Chrome, then tap Reload. This WebView cannot"
                      + " load LINA's JavaScript.");
            }
            return false;
          }

          @Override
          public boolean onShowFileChooser(
              WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
              startActivityForResult(params.createIntent(), PICK_FILE);
            } catch (ActivityNotFoundException e) {
              fileCallback.onReceiveValue(null);
              fileCallback = null;
            }
            return true;
          }
        });
    String saved = getIntent().getStringExtra("url");
    if (saved == null) saved = preferences.getString("origin", null);
    if (saved == null) {
      showStatus(
          "Tap Connection and enter your LINA Tailscale address (from `lina tailscale on`), or"
              + " start your SSH tunnel and paste the LINA URL including #token=….");
      showConnection();
    } else {
      try {
        String pin = getIntent().getStringExtra("url") == null
            ? preferences.getString("certificateSha256", "")
            : getIntent().getStringExtra("certificateSha256");
        connect(new Connection(saved, pin));
      } catch (IllegalArgumentException e) {
        preferences.edit().clear().apply();
        showConnection();
      }
    }
  }

  private void connect(Connection next) {
    connection = next;
    // Save only the origin, never the token-bearing input URL. The web UI owns login storage.
    preferences.edit().putString("origin", next.origin)
        .putString("certificateSha256", next.certificateSha256).apply();
    status.setVisibility(View.GONE);
    web.clearHistory();
    web.loadUrl(next.url);
  }

  private void showConnection() {
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setSaveEnabled(false);
    input.setInputType(
        InputType.TYPE_CLASS_TEXT
            | InputType.TYPE_TEXT_VARIATION_URI
            | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    input.setText(preferences.getString("origin", "https://"));
    input.setHint("https://NAME.ts.net:7077/");
    input.setSelectAllOnFocus(true);
    EditText token = new EditText(this);
    token.setSingleLine(true);
    token.setSaveEnabled(false);
    token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    token.setHint("Token (SSH tunnel only; not needed with Tailscale)");
    LinearLayout form = new LinearLayout(this);
    form.setOrientation(LinearLayout.VERTICAL);
    form.setPadding(dp(20), 0, dp(20), 0);
    TextView help = new TextView(this);
    help.setText(
        "Tailscale: enter the address printed by `lina tailscale on` (https://NAME.ts.net:PORT/)."
            + " You sign in with your Tailscale account, no token. SSH tunnel: paste the"
            + " http://127.0.0.1 URL with #token=…, or enter the address and token separately.");
    form.addView(help);
    form.addView(input);
    form.addView(token);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Connect to LINA")
            .setView(form)
            .setPositiveButton("Connect", null)
            .setNegativeButton("Cancel", null)
            .setNeutralButton("Forget web login", (d, which) -> forget())
            .create();
    dialog.setOnShowListener(
        d ->
            dialog
                .getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(
                    v -> {
                      try {
                        String url = input.getText().toString().trim();
                        String secret = token.getText().toString().trim();
                        if (!secret.isEmpty())
                          url = url.split("#", 2)[0] + "#token=" + Uri.encode(secret);
                        if (url.equals("https://") || url.isEmpty())
                          throw new IllegalArgumentException("Enter your LINA address.");
                        Connection next = new Connection(url);
                        input.setText("");
                        token.setText("");
                        connect(next);
                        dialog.dismiss();
                      } catch (IllegalArgumentException e) {
                        input.setError(e.getMessage());
                      }
                    }));
    dialog.show();
  }

  private void forget() {
    web.stopLoading();
    web.evaluateJavascript(
        "try { localStorage.removeItem('lina.token'); sessionStorage.removeItem('lina.token'); }"
            + " catch (e) {}",
        ignored -> {
          connection = null;
          web.loadUrl("about:blank");
          web.clearHistory();
          web.clearCache(true);
          WebStorage.getInstance().deleteAllData();
          CookieManager.getInstance().removeAllCookies(null);
          preferences.edit().clear().apply();
          showStatus("Web login cleared. The native app connection is managed separately.");
        });
  }

  private void showStatus(String message) {
    status.setText(message);
    status.setVisibility(View.VISIBLE);
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  @Override
  public void onBackPressed() {
    back();
  }

  private void back() {
    if (web.canGoBack()) web.goBack();
    else finish();
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == PICK_FILE && fileCallback != null) {
      fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
      fileCallback = null;
    }
  }

  @Override
  protected void onPause() {
    CookieManager.getInstance().flush();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    web.stopLoading();
    web.destroy();
    super.onDestroy();
  }
}
