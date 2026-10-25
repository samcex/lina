package app.lina.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native Android client: chat and live activity work without JavaScript or a WebView. */
public final class MainActivity extends Activity {
  private static final int FILE = 7;
  private static final int BG = Design.BG, FG = Design.TEXT, MUTED = Design.MUTED;
  private final Handler handler = new Handler();
  private final ExecutorService io = Executors.newFixedThreadPool(2);
  private SharedPreferences prefs;
  private ApiClient api;
  private AutomaticConnection automatic;
  private int generation;
  private int transportGeneration;
  private boolean foreground, polling, sending;
  private int uploading;
  private String sessionId, projectId, contentKey = "", fileSession;
  private JSONObject snapshot;
  private JSONArray projects = new JSONArray(), sessions = new JSONArray();
  private final ArrayList<JSONObject> attachments = new ArrayList<>();
  private LinearLayout root, body, messages, composerRow, streamMessages;
  private long renderedMessageSeq = -1, cursor, targetEvent;
  private boolean hasEarlier, earlierLoading;
  private Button earlier;
  private ScrollView scroll;
  private TextView connectionStatus, heading, agentStatus, attachmentStatus, liveDetails;
  private String agentFilter = "all";
  private int activityOffset;
  private ScrollView liveScroll;
  private EditText composer;
  private Button send, backButton, newButton;
  private LinearLayout homeTools, sessionTools;
  private TextView composerHint;
  private EditText conversationSearch;
  private String sessionQuery = "", sessionFilter = "All";
  private final ArrayList<Button> filters = new ArrayList<>();
  private final Runnable ticker =
      new Runnable() {
        public void run() {
          if (foreground) {
            refresh(false);
            handler.postDelayed(this, 1500);
          }
        }
      };

  private interface Work {
    Object run(ApiClient client) throws Exception;
  }

  private interface Done {
    void run(Object result) throws Exception;
  }

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences("connection", MODE_PRIVATE);
    sessionId = state == null ? prefs.getString("session", null) : state.getString("session");
    fileSession = state == null ? null : state.getString("fileSession");
    root = column();
    root.setPadding(dp(20), 0, dp(20), 0);
    root.setBackgroundColor(BG);
    root.setFocusableInTouchMode(true);
    root.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets p =
                insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            view.setPadding(dp(20) + p.left, p.top, dp(20) + p.right, p.bottom);
          } else
            view.setPadding(
                dp(20) + insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                dp(20) + insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom());
          return Build.VERSION.SDK_INT >= 30
              ? WindowInsets.CONSUMED
              : insets.consumeSystemWindowInsets();
        });
    getWindow().setStatusBarColor(BG);
    getWindow().setNavigationBarColor(BG);
    LinearLayout bar = row();
    bar.setPadding(0, dp(8), 0, dp(8));
    backButton = Design.icon(this, "back", "Sessions", v -> showSessions());
    bar.addView(backButton, new LinearLayout.LayoutParams(dp(44), dp(44)));
    ImageView mark = new ImageView(this);
    mark.setImageResource(getResources().getIdentifier("lina_icon", "drawable", getPackageName()));
    bar.addView(mark, new LinearLayout.LayoutParams(dp(30), dp(30)));
    TextView logo = label("Lina", 21);
    logo.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    logo.setPadding(dp(7), 0, dp(12), 0);
    bar.addView(logo);
    connectionStatus = label("Connect your workspace", 11);
    connectionStatus.setTextColor(MUTED);
    connectionStatus.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
    connectionStatus.setMaxLines(1);
    connectionStatus.setEllipsize(TextUtils.TruncateAt.END);
    connectionStatus.setOnClickListener(v -> showConnection());
    bar.addView(connectionStatus, new LinearLayout.LayoutParams(0, dp(44), 1));
    bar.addView(
        Design.icon(this, "more", "Menu", v -> menu()),
        new LinearLayout.LayoutParams(dp(44), dp(44)));
    root.addView(bar);
    LinearLayout titleRow = row();
    titleRow.setPadding(0, dp(14), 0, dp(5));
    heading = label("Conversations", 30);
    heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    heading.setMaxLines(2);
    heading.setEllipsize(TextUtils.TruncateAt.END);
    titleRow.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
    newButton = button("New chat", v -> newSession());
    newButton.setContentDescription("New conversation");
    Design.button(newButton, true);
    LinearLayout.LayoutParams newSpace = new LinearLayout.LayoutParams(-2, dp(44));
    newSpace.leftMargin = dp(12);
    titleRow.addView(newButton, newSpace);
    root.addView(titleRow);
    agentStatus = label("Pick up where you left off.", 13);
    agentStatus.setTextColor(MUTED);
    agentStatus.setPadding(0, 0, 0, dp(16));
    root.addView(agentStatus);
    homeTools = column();
    conversationSearch = input("Search conversations", false);
    conversationSearch.setCompoundDrawablesWithIntrinsicBounds(
        new Design.Mark(this, "search", MUTED), null, null, null);
    conversationSearch.setCompoundDrawablePadding(dp(10));
    conversationSearch.setInputType(InputType.TYPE_CLASS_TEXT);
    homeTools.addView(conversationSearch, new LinearLayout.LayoutParams(-1, dp(46)));
    LinearLayout filterRow = row();
    filterRow.setPadding(0, dp(12), 0, dp(12));
    for (String name : new String[] {"All", "Active", "Needs you"}) {
      Button f =
          button(
              name,
              v -> {
                sessionFilter = name;
                styleFilters();
                conversationRows();
              });
      f.setTextSize(12);
      LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-2, dp(44));
      space.rightMargin = dp(8);
      filterRow.addView(f, space);
      filters.add(f);
    }
    homeTools.addView(filterRow);
    styleFilters();
    conversationSearch.addTextChangedListener(
        new TextWatcher() {
          public void beforeTextChanged(CharSequence t, int start, int count, int after) {}

          public void onTextChanged(CharSequence t, int start, int before, int count) {
            sessionQuery = t.toString().trim();
            if (sessionId == null) conversationRows();
          }

          public void afterTextChanged(Editable e) {}
        });
    root.addView(homeTools);
    sessionTools = row();
    sessionTools.setPadding(0, 0, 0, dp(12));
    String[] names = {"Activity", "Changes", "Files"};
    for (int i = 0; i < names.length; i++) {
      final int index = i;
      Button tool =
          button(
              names[i],
              v -> {
                if (index == 0) activity();
                else if (index == 1) changes();
                else files();
              });
      tool.setTextSize(12);
      LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(0, dp(44), 1);
      if (i < 2) space.rightMargin = dp(8);
      sessionTools.addView(tool, space);
    }
    root.addView(sessionTools);
    earlier = button("Load earlier messages", v -> loadEarlier());
    earlier.setVisibility(View.GONE);
    root.addView(earlier);
    body = column();
    root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));
    scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);
    scroll.setPadding(0, dp(4), 0, dp(12));
    scroll.setVerticalScrollBarEnabled(false);
    messages = column();
    scroll.addView(messages);
    body.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    attachmentStatus = label("", 12);
    attachmentStatus.setTextColor(Design.ACCENT);
    attachmentStatus.setOnClickListener(v -> showAttachments());
    root.addView(attachmentStatus);
    composerRow = column();
    composerRow.setPadding(dp(12), dp(6), dp(8), dp(6));
    composerRow.setBackground(Design.shape(this, Design.SURFACE, 20, Design.BORDER));
    composer = new EditText(this);
    composer.setTextColor(FG);
    composer.setHintTextColor(MUTED);
    composer.setTextSize(16);
    composer.setBackgroundColor(Color.TRANSPARENT);
    composer.setPadding(dp(4), dp(8), dp(4), dp(8));
    composer.setHint("Message your agents…");
    composer.setMinLines(1);
    composer.setMaxLines(5);
    composer.setInputType(
        InputType.TYPE_CLASS_TEXT
            | InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
    composer.setContentDescription("Message");
    composerRow.addView(composer, new LinearLayout.LayoutParams(-1, -2));
    LinearLayout composeActions = row();
    composeActions.addView(
        Design.icon(this, "attach", "Attach", v -> pickFile()),
        new LinearLayout.LayoutParams(dp(44), dp(44)));
    composerHint = label("Codex + Claude", 11);
    composerHint.setTextColor(MUTED);
    composerHint.setPadding(dp(8), 0, 0, 0);
    composeActions.addView(composerHint, new LinearLayout.LayoutParams(0, -2, 1));
    send = Design.icon(this, "send", "Send", v -> sendMessage(false));
    send.setBackground(Design.touch(this, Design.ACCENT, 14, 0));
    composeActions.addView(send, new LinearLayout.LayoutParams(dp(44), dp(44)));
    composerRow.addView(composeActions);
    LinearLayout.LayoutParams composeSpace = new LinearLayout.LayoutParams(-1, -2);
    composeSpace.topMargin = dp(6);
    composeSpace.bottomMargin = dp(8);
    root.addView(composerRow, composeSpace);
    composer.addTextChangedListener(
        new TextWatcher() {
          public void beforeTextChanged(CharSequence t, int start, int count, int after) {}

          public void onTextChanged(CharSequence t, int start, int before, int count) {
            updateSendState();
          }

          public void afterTextChanged(Editable e) {}
        });
    setContentView(root);
    root.requestFocus();
    homeTools.setVisibility(sessionId == null ? View.VISIBLE : View.GONE);
    sessionTools.setVisibility(sessionId == null ? View.GONE : View.VISIBLE);
    if (state != null) {
      composer.setText(state.getString("draft", ""));
      restoreAttachments(state.getString("attachments", "[]"));
    } else if (same(sessionId, prefs.getString("draftSession", null))) {
      composer.setText(prefs.getString("draft", ""));
      restoreAttachments(prefs.getString("draftAttachments", "[]"));
    }
    if (sessionId == null) home();
    if (Build.VERSION.SDK_INT >= 33)
      getOnBackInvokedDispatcher()
          .registerOnBackInvokedCallback(
              android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
    restoreConnection();
  }

  private void restoreConnection() {
    String origin = prefs.getString("origin", null);
    if (origin == null) {
      api = null;
      sessionId = null;
      home();
      showConnection();
      return;
    }
    try {
      generation++;
      startAutomaticConnection();
    } catch (IllegalArgumentException e) {
      showConnection();
    }
  }

  private void startAutomaticConnection() {
    if (automatic != null) automatic.close();
    transportGeneration++;
    polling = false;
    api = null;
    updateSendState();
    automatic =
        new AutomaticConnection(
            this,
            prefs,
            new AutomaticConnection.Listener() {
              public void connected(ApiClient client) {
                // A route change is the same server and conversation. Do not invalidate an
                // in-flight
                // send/upload callback, clear a draft, or replay its request on the new route.
                transportGeneration++;
                api = client;
                polling = false;
                updateSendState();
                setText(connectionStatus, AutomaticConnection.label(client));
                refresh(false);
              }

              public void unavailable(String message) {
                transportGeneration++;
                api = null;
                polling = false;
                updateSendState();
                setText(connectionStatus, message);
              }
            });
    setText(connectionStatus, "Finding your LINA connection…");
    if (foreground) automatic.resume();
    else automatic.retry();
  }

  private void async(Work work, Done done, boolean quiet) {
    final ApiClient client = api;
    final int epoch = generation;
    if (client == null) {
      if (!quiet) showConnection();
      return;
    }
    io.execute(
        () -> {
          Object result = null;
          Exception error = null;
          try {
            result = work.run(client);
          } catch (Exception e) {
            error = e;
          }
          final Object value = result;
          final Exception failure = error;
          handler.post(
              () -> {
                if (isFinishing() || isDestroyed() || epoch != generation) return;
                if (failure != null) {
                  if (client == api) setText(connectionStatus, error(failure));
                  if (automatic != null) automatic.retry();
                  if (!quiet) alert("Could not complete request", error(failure));
                } else {
                  if (client == api) setText(connectionStatus, AutomaticConnection.label(client));
                  try {
                    done.run(value);
                  } catch (Exception e) {
                    if (!quiet) alert("Could not display response", error(e));
                  }
                }
              });
        });
  }

  private String error(Exception e) {
    if (e instanceof ApiClient.ApiException) {
      ApiClient.ApiException a = (ApiClient.ApiException) e;
      if (a.status == 401)
        return "Sign-in expired. Open Menu → Connection and paste the current LINA URL/token.";
      try {
        JSONObject j = new JSONObject(a.body);
        return j.optString("error", "HTTP " + a.status)
            + (j.optString("hint").isEmpty() ? "" : "\n" + j.optString("hint"));
      } catch (Exception ignored) {
        return "HTTP " + a.status;
      }
    }
    return "Connection unavailable. Check home Wi-Fi, Tailscale or the SSH tunnel. "
        + (e.getMessage() == null ? "" : e.getMessage());
  }

  private void refresh(boolean force) {
    if (api == null || polling) return;
    polling = true;
    final ApiClient client = api;
    final int epoch = generation;
    final int transport = transportGeneration;
    final String id = sessionId;
    final long since = snapshot == null ? 0 : cursor;
    io.execute(
        () -> {
          Object value = null;
          Exception failure = null;
          try {
            value =
                id == null
                    ? new JSONArray(client.request("GET", "/api/sessions", null))
                    : new JSONObject(
                        client.request("GET", "/api/sessions/" + id + "?since=" + since, null));
          } catch (Exception e) {
            failure = e;
          }
          final Object result = value;
          final Exception problem = failure;
          handler.post(
              () -> {
                if (epoch != generation
                    || transport != transportGeneration
                    || !same(id, sessionId)
                    || isDestroyed()) return;
                polling = false;
                if (problem != null) {
                  setText(connectionStatus, error(problem));
                  if (automatic != null) automatic.retry();
                  if (problem instanceof ApiClient.ApiException
                      && ((ApiClient.ApiException) problem).status == 404) {
                    sessionId = null;
                    prefs.edit().remove("session").apply();
                    home();
                  }
                  return;
                }
                setText(connectionStatus, AutomaticConnection.label(client));
                if (id == null) {
                  sessions = (JSONArray) result;
                  if (force || !contentKey.equals(sessions.toString())) home();
                } else {
                  JSONObject incoming = (JSONObject) result;
                  if (since > 0 && snapshot != null) {
                    JSONArray oldEvents = snapshot.optJSONArray("events");
                    JSONArray newEvents = incoming.optJSONArray("events");
                    if (oldEvents == null) oldEvents = new JSONArray();
                    if (newEvents != null)
                      for (int i = 0; i < newEvents.length(); i++) {
                        JSONObject event = newEvents.optJSONObject(i);
                        if (event != null && event.optLong("seq") > since) oldEvents.put(event);
                      }
                    try {
                      incoming.put("events", oldEvents);
                    } catch (Exception ignored) {
                    }
                  }
                  JSONObject history = incoming.optJSONObject("history");
                  JSONArray received = incoming.optJSONArray("events");
                  long receivedCursor = since;
                  if (received != null)
                    for (int i = 0; i < received.length(); i++) {
                      JSONObject event = received.optJSONObject(i);
                      if (event != null)
                        receivedCursor = Math.max(receivedCursor, event.optLong("seq"));
                    }
                  cursor =
                      history == null ? receivedCursor : history.optLong("cursor", receivedCursor);
                  if (since == 0) hasEarlier = history != null && history.optBoolean("hasEarlier");
                  snapshot = incoming;
                  renderSession(force);
                  if (foreground
                      && history != null
                      && history.optBoolean("hasLater")
                      && cursor > since) handler.post(() -> refresh(false));
                }
              });
        });
  }

  private static boolean same(String a, String b) {
    return a == null ? b == null : a.equals(b);
  }

  private void home() {
    earlier.setVisibility(View.GONE);
    backButton.setVisibility(View.GONE);
    newButton.setVisibility(View.VISIBLE);
    homeTools.setVisibility(View.VISIBLE);
    sessionTools.setVisibility(View.GONE);
    heading.setTextSize(30);
    setText(heading, "Conversations");
    setText(agentStatus, "Pick up where you left off.");
    agentStatus.setTextColor(MUTED);
    agentStatus.setOnClickListener(null);
    composerRow.setVisibility(View.GONE);
    attachmentStatus.setVisibility(View.GONE);
    contentKey = sessions.toString();
    conversationRows();
  }

  private void styleFilters() {
    for (Button f : filters) {
      boolean selected = f.getText().toString().equals(sessionFilter);
      f.setTextColor(selected ? Design.ACCENT : MUTED);
      f.setBackground(
          Design.touch(
              this, selected ? 0xff292535 : BG, 20, selected ? 0xff40384f : Design.BORDER));
      f.setSelected(selected);
    }
  }

  private String statusLabel(String status) {
    switch (status) {
      case "running":
        return "Working";
      case "paused":
        return "Paused";
      case "awaiting_approval":
        return "Ready to review";
      case "completed":
      case "approved":
        return "Completed";
      case "failed":
      case "interrupted":
        return "Stopped";
      case "cancelled":
      case "rejected":
        return "Closed";
      default:
        return "Ready";
    }
  }

  private int statusColor(String status) {
    if (status.equals("running")) return Design.GREEN;
    if (status.equals("paused") || status.equals("awaiting_approval")) return Design.AMBER;
    return MUTED;
  }

  private String relativeTime(long at) {
    long minutes = Math.max(0, (System.currentTimeMillis() - at) / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return minutes + "m ago";
    if (minutes < 1440) return minutes / 60 + "h ago";
    if (minutes < 10080) return minutes / 1440 + "d ago";
    return android.text.format.DateFormat.format("MMM d", at).toString();
  }

  private void conversationRows() {
    messages.removeAllViews();
    ArrayList<JSONObject> rows = new ArrayList<>();
    for (int i = 0; i < sessions.length(); i++) {
      JSONObject item = sessions.optJSONObject(i);
      if (item != null) rows.add(item);
    }
    rows.sort((a, b) -> Long.compare(b.optLong("updatedAt"), a.optLong("updatedAt")));
    int visible = 0;
    for (JSONObject item : rows) {
      String state = item.optString("status"),
          title = item.optString("title", "Untitled conversation");
      if (!title
          .toLowerCase(java.util.Locale.ROOT)
          .contains(sessionQuery.toLowerCase(java.util.Locale.ROOT))) continue;
      if (sessionFilter.equals("Active") && !state.equals("running") && !state.equals("paused"))
        continue;
      if (sessionFilter.equals("Needs you")
          && !state.equals("awaiting_approval")
          && !state.equals("paused")) continue;
      LinearLayout itemRow = row();
      itemRow.setPadding(dp(14), dp(14), dp(10), dp(14));
      itemRow.setMinimumHeight(dp(86));
      itemRow.setBackground(Design.touch(this, Design.SURFACE, 16, 0));
      itemRow.setOnClickListener(v -> openSession(item.optString("id")));
      itemRow.setFocusable(true);
      ImageView icon = new ImageView(this);
      icon.setImageDrawable(
          new Design.Mark(this, "chat", state.equals("running") ? Design.GREEN : Design.ACCENT));
      icon.setPadding(dp(9), dp(9), dp(9), dp(9));
      icon.setBackground(Design.shape(this, 0xff24232e, 12, 0));
      itemRow.addView(icon, new LinearLayout.LayoutParams(dp(38), dp(38)));
      LinearLayout copy = column();
      copy.setPadding(dp(12), 0, dp(10), 0);
      TextView name = label(title, 16);
      name.setTypeface(Typeface.create("sans-serif-medium", 0));
      name.setMaxLines(2);
      name.setEllipsize(TextUtils.TruncateAt.END);
      // The full title remains available to screen readers and transcript navigation.
      name.setContentDescription(title);
      copy.addView(name);
      TextView meta =
          label(statusLabel(state) + "  ·  " + relativeTime(item.optLong("updatedAt")), 12);
      meta.setTextColor(statusColor(state));
      meta.setPadding(0, dp(6), 0, 0);
      copy.addView(meta);
      itemRow.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
      ImageView arrow = new ImageView(this);
      arrow.setImageDrawable(new Design.Mark(this, "chevron", MUTED));
      itemRow.addView(arrow, new LinearLayout.LayoutParams(dp(16), dp(16)));
      LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, -2);
      space.bottomMargin = dp(8);
      messages.addView(itemRow, space);
      visible++;
    }
    if (visible == 0) {
      LinearLayout empty = column();
      empty.setGravity(Gravity.CENTER);
      empty.setPadding(dp(16), dp(42), dp(16), dp(36));
      ImageView icon = new ImageView(this);
      icon.setImageDrawable(new Design.Mark(this, "chat", Design.ACCENT));
      icon.setPadding(dp(16), dp(16), dp(16), dp(16));
      icon.setBackground(Design.shape(this, 0xff24232e, 20, 0));
      empty.addView(icon, new LinearLayout.LayoutParams(dp(64), dp(64)));
      String title =
          api == null
              ? "Your workspace, wherever you are"
              : sessions.length() == 0 ? "Start something new" : "No matches";
      TextView h = label(title, 20);
      h.setGravity(Gravity.CENTER);
      h.setPadding(0, dp(20), 0, dp(8));
      empty.addView(h);
      TextView help =
          label(
              api == null
                  ? "Connect your PC to bring your conversations here."
                  : sessions.length() == 0
                      ? "Add a project, then chat with your agents."
                      : "Try another search or conversation filter.",
              14);
      help.setTextColor(MUTED);
      help.setGravity(Gravity.CENTER);
      help.setLineSpacing(dp(3), 1);
      empty.addView(help);
      Button action =
          button(
              api == null
                  ? "Connect to LINA"
                  : sessions.length() == 0 ? "Add project" : "Clear filters",
              v -> {
                if (api == null) showConnection();
                else if (sessions.length() == 0) addProject();
                else {
                  sessionFilter = "All";
                  styleFilters();
                  conversationSearch.setText("");
                  conversationRows();
                }
              });
      Design.button(action, true);
      LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-2, dp(46));
      space.topMargin = dp(24);
      empty.addView(action, space);
      messages.addView(empty, new LinearLayout.LayoutParams(-1, -2));
    }
  }

  private void showSessions() {
    if (!composer.getText().toString().isEmpty() || !attachments.isEmpty()) {
      new AlertDialog.Builder(this)
          .setTitle("Leave this draft?")
          .setMessage("Your message and attached files have not been sent.")
          .setNegativeButton("Keep writing", null)
          .setPositiveButton("Discard", (d, w) -> leaveSession())
          .show();
    } else leaveSession();
  }

  private void leaveSession() {
    generation++;
    earlierLoading = false;
    hasEarlier = false;
    cursor = 0;
    targetEvent = 0;
    uploading = 0;
    updateSendState();
    polling = false;
    sessionId = null;
    snapshot = null;
    composer.setText("");
    attachments.clear();
    prefs.edit().remove("session").apply();
    contentKey = "";
    home();
    refresh(true);
  }

  private void openSession(String id) {
    composer.setText("");
    attachments.clear();
    saveDraft();
    generation++;
    earlierLoading = false;
    hasEarlier = false;
    cursor = 0;
    targetEvent = 0;
    uploading = 0;
    updateSendState();
    polling = false;
    sessionId = id;
    backButton.setVisibility(View.VISIBLE);
    newButton.setVisibility(View.GONE);
    homeTools.setVisibility(View.GONE);
    sessionTools.setVisibility(View.VISIBLE);
    heading.setTextSize(22);
    snapshot = null;
    prefs.edit().putString("session", id).apply();
    contentKey = "";
    composerRow.setVisibility(View.VISIBLE);
    attachmentStatus.setVisibility(View.VISIBLE);
    messages.removeAllViews();
    setText(heading, "Loading conversation…");
    refresh(true);
  }

  private void renderSession(boolean force) {
    JSONObject s = snapshot.optJSONObject("session");
    if (s == null) return;
    setText(heading, s.optString("title", "Conversation"));
    backButton.setVisibility(View.VISIBLE);
    newButton.setVisibility(View.GONE);
    homeTools.setVisibility(View.GONE);
    sessionTools.setVisibility(View.VISIBLE);
    heading.setTextSize(22);
    JSONObject live = snapshot.optJSONObject("live");
    String state = s.optString("status"), phase = s.optString("phase");
    String detail =
        state.equals("running")
            ? statusLabel(state) + " · " + phase.replace('_', ' ')
            : statusLabel(state);
    setText(agentStatus, detail + (s.optBoolean("mock") ? " · Simulated agents" : ""));
    agentStatus.setTextColor(statusColor(state));
    agentStatus.setOnClickListener(v -> activity());
    JSONObject config = s.optJSONObject("config");
    if (config != null)
      setText(
          composerHint,
          (config.optString("developer", "codex").equals("claude") ? "Claude" : "Codex")
              + " · "
              + config.optString("mode", "pair"));
    updateActivity();
    earlier.setVisibility(hasEarlier ? View.VISIBLE : View.GONE);
    earlier.setEnabled(!earlierLoading);
    composerRow.setVisibility(View.VISIBLE);
    attachmentStatus.setVisibility(View.VISIBLE);
    updateAttachments();
    // A paged replay can keep the same session high-water mark while its delivered
    // cursor advances. Each page must still refresh newly received messages.
    String key =
        s.optLong("lastSeq")
            + ":"
            + cursor
            + ":"
            + (live == null ? "" : live.optJSONObject("streams"));
    if (!force && key.equals(contentKey)) return;
    contentKey = key;
    boolean bottom =
        scroll.getChildAt(0).getHeight() - scroll.getHeight() - scroll.getScrollY() < dp(120);
    JSONArray events = snapshot.optJSONArray("events");
    long messageSeq = 0;
    if (events != null)
      for (int i = 0; i < events.length(); i++) {
        JSONObject event = events.optJSONObject(i);
        if (event != null
            && (event.optString("type").equals("message")
                || event.optString("type").equals("error")
                || event.optString("type").equals("tests")))
          messageSeq = Math.max(messageSeq, event.optLong("seq"));
      }
    if (force
        || messageSeq != renderedMessageSeq
        || streamMessages == null
        || streamMessages.getParent() != messages) {
      messages.removeAllViews();
      renderedMessageSeq = messageSeq;
      if (events != null)
        for (int i = 0; i < events.length(); i++) {
          JSONObject event = events.optJSONObject(i);
          if (event == null) continue;
          JSONObject data = event.optJSONObject("data");
          if (data == null) continue;
          String type = event.optString("type");
          if (type.equals("message")) {
            cardEvent(
                event.optLong("seq"),
                event.optString("actor") + " · " + data.optString("kind"),
                event.optString("actor").equals("user")
                    ? data.optString("text")
                    : displayText(data.optString("text")));
            JSONArray files = data.optJSONArray("attachments");
            if (files != null)
              for (int f = 0; f < files.length(); f++) {
                JSONObject file = files.optJSONObject(f);
                if (file != null)
                  messages.addView(label("Attached: " + file.optString("name"), 12));
              }
          } else if (type.equals("error"))
            cardEvent(
                event.optLong("seq"),
                "LINA · " + data.optString("code"),
                data.optString("message") + "\n" + data.optString("hint"));
          else if (type.equals("tests"))
            cardEvent(
                event.optLong("seq"),
                data.has("skippedReason")
                    ? "Tests · skipped"
                    : "Tests · exit " + data.optString("exitCode"),
                data.has("skippedReason")
                    ? data.optString("skippedReason")
                    : data.optString("command") + "\n" + data.optString("output"));
        }
      if (events == null || messageSeq == 0)
        messages.addView(label("Start the conversation below.", 16));
      streamMessages = column();
      messages.addView(streamMessages);
    }
    streamMessages.removeAllViews();
    if (live != null) {
      JSONObject streams = live.optJSONObject("streams");
      if (streams != null) {
        java.util.Iterator<String> keys = streams.keys();
        while (keys.hasNext()) {
          JSONObject stream = streams.optJSONObject(keys.next());
          if (stream != null)
            cardInto(
                streamMessages,
                stream.optString("agent") + " · writing now",
                displayText(stream.optString("text")));
        }
      }
    }
    if (force || bottom) scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    if (targetEvent > 0) {
      View target = messages.findViewWithTag("event-" + targetEvent);
      if (target != null) {
        targetEvent = 0;
        scroll.post(() -> scroll.scrollTo(0, target.getTop()));
      } else if (hasEarlier && !earlierLoading) loadEarlier();
    }
  }

  private void loadEarlier() {
    if (snapshot == null || sessionId == null || earlierLoading) return;
    JSONArray existing = snapshot.optJSONArray("events");
    if (existing == null || existing.length() == 0) return;
    long first = Long.MAX_VALUE;
    for (int i = 0; i < existing.length(); i++) {
      JSONObject event = existing.optJSONObject(i);
      if (event != null && event.optLong("seq") > 0) first = Math.min(first, event.optLong("seq"));
    }
    if (first == Long.MAX_VALUE) return;
    final long before = first;
    final String id = sessionId;
    final ApiClient client = api;
    final int epoch = generation;
    earlierLoading = true;
    earlier.setEnabled(false);
    io.execute(
        () -> {
          JSONArray page = null;
          Exception failure = null;
          try {
            page =
                new JSONArray(
                    client.request(
                        "GET",
                        "/api/sessions/" + id + "/events?before=" + before + "&limit=500",
                        null));
          } catch (Exception e) {
            failure = e;
          }
          final JSONArray result = page;
          final Exception problem = failure;
          handler.post(
              () -> {
                if (epoch != generation || !same(id, sessionId) || isDestroyed()) return;
                earlierLoading = false;
                earlier.setEnabled(true);
                if (problem != null) {
                  alert("Could not load earlier messages", error(problem));
                  return;
                }
                JSONArray merged = new JSONArray();
                for (int i = 0; i < result.length(); i++) {
                  JSONObject event = result.optJSONObject(i);
                  if (event != null && event.optLong("seq") < before) merged.put(event);
                }
                JSONArray current = snapshot.optJSONArray("events");
                if (current != null)
                  for (int i = 0; i < current.length(); i++) merged.put(current.opt(i));
                put(snapshot, "events", merged);
                hasEarlier = result.length() == 500 && merged.optJSONObject(0).optLong("seq") > 1;
                int previousHeight = messages.getHeight(), previousOffset = scroll.getScrollY();
                boolean navigating = targetEvent > 0;
                renderedMessageSeq = -1;
                contentKey = "";
                renderSession(false);
                if (!navigating)
                  scroll.post(
                      () ->
                          scroll.scrollTo(
                              0,
                              Math.max(0, previousOffset + messages.getHeight() - previousHeight)));
              });
        });
  }

  private String displayText(String text) {
    return text.replaceAll(
            "(?s)```(?:lina-chat|lina-review|lina-response|lina-split)\\s*.*?```", "")
        .trim();
  }

  private void cardEvent(long seq, String title, String text) {
    int before = messages.getChildCount();
    cardInto(messages, title, text);
    messages.getChildAt(before).setTag("event-" + seq);
  }

  private void card(String title, String text) {
    cardInto(messages, title, text);
  }

  private void cardInto(LinearLayout parent, String title, String text) {
    boolean user = title.startsWith("user ·"),
        notice = title.startsWith("lina ·"),
        tests = title.startsWith("Tests");
    LinearLayout outer = column();
    LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, -2);
    space.topMargin = dp(10);
    space.bottomMargin = dp(12);
    if (user) {
      space.leftMargin = dp(32);
      outer.setPadding(dp(16), dp(13), dp(16), dp(14));
      outer.setBackground(Design.shape(this, 0xff282331, 18, 0));
    } else if (notice || tests) {
      outer.setPadding(dp(14), dp(12), dp(14), dp(12));
      outer.setBackground(Design.shape(this, Design.SURFACE, 12, Design.BORDER));
    } else outer.setPadding(0, dp(6), 0, dp(4));
    String author =
        user
            ? "You"
            : notice
                ? "Workspace"
                : title.startsWith("codex")
                    ? "Codex"
                    : title.startsWith("claude") ? "Claude" : title;
    TextView h = label(author, 12);
    h.setTypeface(Typeface.create("sans-serif-medium", 0));
    h.setTextColor(
        user
            ? Design.ACCENT
            : notice ? MUTED : title.startsWith("claude") ? 0xffdfac8e : Design.ACCENT);
    h.setPadding(0, 0, 0, dp(8));
    outer.addView(h);
    TextView t = label("", notice ? 13 : 16);
    t.setText(user ? text : MessageText.format(text));
    t.setTextColor(notice ? MUTED : FG);
    t.setTextIsSelectable(true);
    t.setLineSpacing(dp(notice ? 3 : 5), 1);
    outer.addView(t);
    parent.addView(outer, space);
  }

  private void restoreAttachments(String value) {
    try {
      JSONArray list = new JSONArray(value);
      for (int i = 0; i < list.length(); i++) attachments.add(list.getJSONObject(i));
    } catch (Exception ignored) {
      attachments.clear();
    }
    updateAttachments();
  }

  private String attachmentJson() {
    JSONArray list = new JSONArray();
    for (JSONObject item : attachments) list.put(item);
    return list.toString();
  }

  private void saveDraft() {
    prefs
        .edit()
        .putString("draftSession", sessionId)
        .putString("draft", composer.getText().toString())
        .putString("draftAttachments", attachmentJson())
        .apply();
  }

  private void sendMessage(boolean interrupt) {
    if (sending || uploading > 0 || sessionId == null || api == null) return;
    final String id = sessionId, draft = composer.getText().toString();
    final ApiClient client = api;
    if (draft.trim().isEmpty() && attachments.isEmpty()) return;
    JSONArray ids = new JSONArray();
    for (JSONObject a : attachments) ids.put(a.optString("id"));
    JSONObject payload =
        json(
            "text",
            draft.trim().isEmpty() ? "Please inspect the attached files." : draft,
            "attachments",
            ids,
            "interrupt",
            interrupt);
    sending = true;
    updateSendState();
    final int epoch = generation;
    io.execute(
        () -> {
          Exception failure = null;
          try {
            client.request("POST", "/api/sessions/" + id + "/messages", payload.toString());
          } catch (Exception e) {
            failure = e;
          }
          final Exception problem = failure;
          handler.post(
              () -> {
                sending = false;
                updateSendState();
                if (epoch != generation || !same(id, sessionId)) return;
                if (problem != null) {
                  alert(
                      "Message delivery was not confirmed",
                      error(problem)
                          + "\n"
                          + "Your draft is retained. Check the conversation before sending it"
                          + " again.");
                  return;
                }
                if (composer.getText().toString().equals(draft)) composer.setText("");
                for (int i = attachments.size() - 1; i >= 0; i--) {
                  for (int j = 0; j < ids.length(); j++)
                    if (attachments.get(i).optString("id").equals(ids.optString(j))) {
                      attachments.remove(i);
                      break;
                    }
                }
                updateAttachments();
                saveDraft();
                ((InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE))
                    .hideSoftInputFromWindow(composer.getWindowToken(), 0);
                refresh(true);
              });
        });
  }

  private void pickFile() {
    if (sessionId == null) return;
    fileSession = sessionId;
    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    i.addCategory(Intent.CATEGORY_OPENABLE);
    i.setType("*/*");
    try {
      startActivityForResult(i, FILE);
    } catch (Exception e) {
      alert("No file picker", "Install or enable a document picker to attach files.");
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent intent) {
    super.onActivityResult(request, result, intent);
    if (request != FILE || result != RESULT_OK || intent == null || intent.getData() == null)
      return;
    final String id = fileSession;
    if (!same(id, sessionId)) return;
    final Uri uri = intent.getData();
    String title = "attachment";
    try (Cursor c =
        getContentResolver()
            .query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst()) title = c.getString(0);
    } catch (Exception ignored) {
    }
    final String filename = title;
    final String mime = getContentResolver().getType(uri);
    final ApiClient client = api;
    final int epoch = generation;
    uploading++;
    updateSendState();
    updateAttachments();
    io.execute(
        () -> {
          JSONObject uploaded = null;
          Exception failure = null;
          try {
            byte[] bytes =
                ApiClient.read(getContentResolver().openInputStream(uri), 20 * 1024 * 1024);
            uploaded =
                new JSONObject(
                    client.request(
                        "POST",
                        "/api/sessions/" + id + "/attachments",
                        bytes,
                        mime == null ? "application/octet-stream" : mime,
                        URLEncoder.encode(filename, "UTF-8").replace("+", "%20")));
          } catch (Exception e) {
            failure = e;
          }
          final JSONObject value = uploaded;
          final Exception problem = failure;
          handler.post(
              () -> {
                if (epoch != generation || !same(id, sessionId) || isDestroyed()) return;
                uploading--;
                updateSendState();
                if (problem != null) alert("File was not attached", error(problem));
                else attachments.add(value);
                updateAttachments();
                saveDraft();
              });
        });
  }

  private void updateSendState() {
    if (send != null)
      send.setEnabled(
          api != null
              && sessionId != null
              && !sending
              && uploading == 0
              && (!composer.getText().toString().trim().isEmpty() || !attachments.isEmpty()));
  }

  private void updateAttachments() {
    updateSendState();
    attachmentStatus.setVisibility(
        sessionId != null && (uploading > 0 || !attachments.isEmpty()) ? View.VISIBLE : View.GONE);
    attachmentStatus.setPadding(dp(4), dp(6), dp(4), dp(6));
    if (uploading > 0) {
      setText(attachmentStatus, "Uploading " + uploading + " file(s)…");
      return;
    }
    setText(
        attachmentStatus,
        attachments.isEmpty() ? "" : "Attached " + attachments.size() + " file(s) · tap to remove");
  }

  private void showAttachments() {
    String[] names = new String[attachments.size()];
    for (int i = 0; i < names.length; i++) names[i] = attachments.get(i).optString("name");
    new AlertDialog.Builder(this)
        .setTitle("Tap a file to remove")
        .setItems(
            names,
            (d, w) -> {
              attachments.remove(w);
              updateAttachments();
            })
        .setNegativeButton("Close", null)
        .show();
  }

  private void newSession() {
    if (!composer.getText().toString().isEmpty() || !attachments.isEmpty()) {
      confirm(
          "Discard this draft?",
          "Your message and attached files have not been sent.",
          () -> {
            composer.setText("");
            attachments.clear();
            saveDraft();
            newSession();
          });
      return;
    }
    async(
        client -> new JSONArray(client.request("GET", "/api/projects", null)),
        value -> {
          projects = (JSONArray) value;
          if (projects.length() == 0) {
            addProject();
            return;
          }
          String[] names = new String[projects.length()];
          for (int i = 0; i < names.length; i++)
            names[i] = projects.getJSONObject(i).optString("name");
          new AlertDialog.Builder(this)
              .setTitle("Choose project")
              .setItems(names, (d, w) -> sessionOptions(projects.optJSONObject(w).optString("id")))
              .setNegativeButton("Cancel", null)
              .show();
        },
        false);
  }

  private void sessionOptions(String project) {
    async(
        client -> new JSONObject(client.request("GET", "/api/settings", null)),
        result -> showSessionOptions(project, (JSONObject) result),
        false);
  }

  private void showSessionOptions(String project, JSONObject defaults) {
    JSONObject projectSettings = null;
    for (int i = 0; i < projects.length(); i++) {
      JSONObject candidate = projects.optJSONObject(i);
      if (candidate != null && candidate.optString("id").equals(project)) {
        projectSettings = candidate.optJSONObject("settings");
        break;
      }
    }
    if (projectSettings != null)
      for (String key : new String[] {"defaultMode", "maxRounds", "network", "testCommand"})
        if (projectSettings.has(key)) put(defaults, key, projectSettings.opt(key));
    LinearLayout form = column();
    form.setPadding(dp(16), 0, dp(16), 0);
    EditText title = input("Conversation title (optional)", false);
    form.addView(title);
    Spinner modes =
        spinner(new String[] {"pair", "solo", "architect", "parallel", "compete", "custom"});
    select(modes, defaults.optString("defaultMode", "pair"));
    form.addView(label("Team mode", 13));
    form.addView(modes);
    Spinner developer = spinner(new String[] {"codex", "claude"});
    JSONObject savedTeam = defaults.optJSONObject("team");
    select(
        developer,
        defaults.optString("defaultMode").equals("custom") && savedTeam != null
            ? savedTeam.optString("developer", defaults.optString("developer", "codex"))
            : defaults.optString("developer", "codex"));
    form.addView(label("Developer", 13));
    form.addView(developer);
    CheckBox workflow = check("Structured workflow", false);
    form.addView(workflow);
    CheckBox isolated = check("Isolated workspace", false);
    form.addView(isolated);
    LinearLayout custom = column();
    Spinner planner = spinner(new String[] {"none", "codex", "claude"}),
        critic = spinner(new String[] {"none", "codex", "claude"});
    custom.addView(label("Planner", 13));
    custom.addView(planner);
    custom.addView(label("Plan reviewer", 13));
    custom.addView(critic);
    CheckBox reviewCodex = check("Codex reviews code", false),
        reviewClaude = check("Claude reviews code", true);
    custom.addView(reviewCodex);
    custom.addView(reviewClaude);
    form.addView(custom);
    JSONObject team = defaults.optJSONObject("team");
    if (team != null) {
      select(planner, team.optString("planner", "none"));
      select(critic, team.optString("planCritic", "none"));
      JSONArray reviewers = team.optJSONArray("reviewers");
      reviewCodex.setChecked(false);
      reviewClaude.setChecked(false);
      if (reviewers != null)
        for (int i = 0; i < reviewers.length(); i++) {
          if (reviewers.optString(i).equals("codex")) reviewCodex.setChecked(true);
          if (reviewers.optString(i).equals("claude")) reviewClaude.setChecked(true);
        }
    }
    Runnable enforceWorkspace =
        () -> {
          String mode = modes.getSelectedItem().toString();
          boolean required = mode.equals("parallel") || mode.equals("compete");
          if (required) isolated.setChecked(true);
          isolated.setEnabled(!required);
          isolated.setText(
              required ? "Isolated workspace (required for " + mode + ")" : "Isolated workspace");
          if (isolated.isChecked()) workflow.setChecked(true);
          workflow.setEnabled(!isolated.isChecked());
          workflow.setText(
              isolated.isChecked()
                  ? "Structured workflow (required for isolation)"
                  : "Structured workflow");
        };
    isolated.setOnCheckedChangeListener((button, checked) -> enforceWorkspace.run());
    modes.setOnItemSelectedListener(
        new AdapterView.OnItemSelectedListener() {
          public void onNothingSelected(AdapterView<?> p) {}

          public void onItemSelected(AdapterView<?> p, View view, int index, long id) {
            custom.setVisibility(
                modes.getSelectedItem().equals("custom") ? View.VISIBLE : View.GONE);
            enforceWorkspace.run();
          }
        });
    EditText tests = input("Test command (blank: auto-detect)", false);
    if (defaults.has("testCommand")) tests.setText(defaults.optString("testCommand"));
    form.addView(tests);
    CheckBox skipTests =
        check(
            "Skip automated tests",
            defaults.has("testCommand") && defaults.optString("testCommand").isEmpty());
    form.addView(skipTests);
    EditText rounds = input("Maximum review rounds", false);
    rounds.setInputType(InputType.TYPE_CLASS_NUMBER);
    rounds.setText(Integer.toString(defaults.optInt("maxRounds", 3)));
    form.addView(rounds);
    CheckBox network =
        check("Network access in restricted mode", defaults.optBoolean("network", false));
    form.addView(network);
    ScrollView scroller = new ScrollView(this);
    scroller.addView(form);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("New conversation")
            .setView(scroller)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Create", null)
            .create();
    dialog.setOnShowListener(
        v ->
            dialog
                .getButton(-1)
                .setOnClickListener(
                    w -> {
                      int maximum;
                      try {
                        maximum = Integer.parseInt(rounds.getText().toString());
                        if (maximum < 1 || maximum > 20) throw new NumberFormatException();
                      } catch (NumberFormatException e) {
                        rounds.setError("Choose 1–20 review rounds");
                        return;
                      }
                      String dev = developer.getSelectedItem().toString(),
                          mode = modes.getSelectedItem().toString();
                      boolean isIsolated =
                          isolated.isChecked() || mode.equals("parallel") || mode.equals("compete");
                      JSONObject config =
                          json(
                              "mode",
                              mode,
                              "developer",
                              dev,
                              "reviewer",
                              dev.equals("codex") ? "claude" : "codex",
                              "workspaceMode",
                              isIsolated ? "isolated" : "direct",
                              "interactionMode",
                              (isIsolated || workflow.isChecked()) ? "workflow" : "chat",
                              "maxRounds",
                              maximum,
                              "network",
                              network.isChecked());
                      String test = tests.getText().toString().trim();
                      if (skipTests.isChecked()) put(config, "testCommand", "");
                      else if (!test.isEmpty()) put(config, "testCommand", test);
                      if (mode.equals("custom")) {
                        JSONArray reviewers = new JSONArray();
                        if (reviewCodex.isChecked()) reviewers.put("codex");
                        if (reviewClaude.isChecked()) reviewers.put("claude");
                        String plan = planner.getSelectedItem().toString(),
                            critique = critic.getSelectedItem().toString();
                        put(
                            config,
                            "team",
                            json(
                                "planner",
                                plan.equals("none") ? JSONObject.NULL : plan,
                                "planCritic",
                                critique.equals("none") ? JSONObject.NULL : critique,
                                "developer",
                                dev,
                                "reviewers",
                                reviewers));
                      }
                      JSONObject body = json("projectId", project, "config", config);
                      String name = title.getText().toString().trim();
                      if (!name.isEmpty()) put(body, "title", name);
                      dialog.getButton(-1).setEnabled(false);
                      final ApiClient client = api;
                      final int epoch = generation;
                      io.execute(
                          () -> {
                            JSONObject created = null;
                            Exception failure = null;
                            try {
                              created =
                                  new JSONObject(
                                      client.request("POST", "/api/sessions", body.toString()));
                            } catch (Exception e) {
                              failure = e;
                            }
                            final JSONObject result = created;
                            final Exception problem = failure;
                            handler.post(
                                () -> {
                                  if (epoch != generation || isDestroyed()) return;
                                  dialog.getButton(-1).setEnabled(true);
                                  if (problem != null) {
                                    alert("Could not create conversation", error(problem));
                                    return;
                                  }
                                  dialog.dismiss();
                                  openSession(result.optString("id"));
                                });
                          });
                    }));
    dialog.show();
  }

  private CheckBox check(String text, boolean value) {
    CheckBox c = new CheckBox(this);
    c.setText(text);
    c.setTextColor(FG);
    c.setChecked(value);
    return c;
  }

  private void select(Spinner spinner, String value) {
    for (int i = 0; i < spinner.getCount(); i++)
      if (spinner.getItemAtPosition(i).equals(value)) {
        spinner.setSelection(i);
        return;
      }
  }

  private static void put(JSONObject object, String key, Object value) {
    try {
      object.put(key, value);
    } catch (Exception e) {
      throw new IllegalArgumentException(e);
    }
  }

  private void addProject() {
    LinearLayout form = column();
    EditText path = input("Absolute project path on the host", false);
    form.addView(path);
    CheckBox create = new CheckBox(this);
    create.setText("Create directory and initialize Git if needed");
    create.setTextColor(FG);
    form.addView(create);
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Add host project")
            .setView(form)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Add", null)
            .create();
    d.setOnShowListener(
        v ->
            d.getButton(-1)
                .setOnClickListener(
                    w -> {
                      String p = path.getText().toString().trim();
                      if (!p.startsWith("/")) {
                        path.setError("Enter an absolute path on the host");
                        return;
                      }
                      async(
                          client ->
                              new JSONObject(
                                  client.request(
                                      "POST",
                                      "/api/projects",
                                      json(
                                              "path",
                                              p,
                                              "create",
                                              create.isChecked(),
                                              "initGit",
                                              create.isChecked())
                                          .toString())),
                          value -> {
                            d.dismiss();
                            newSession();
                          },
                          false);
                    }));
    d.show();
  }

  private void menu() {
    final String[] items =
        sessionId == null
            ? new String[] {
              "Connection", "New conversation", "Add project", "Settings", "Open web interface"
            }
            : new String[] {
              "Connection",
              "New conversation",
              "Agent activity",
              "Session controls",
              "Candidate comparison",
              "Changes and undo",
              "Files",
              "Search conversations",
              "Previews",
              "Findings",
              "Models and mode",
              "Settings",
              "Open web interface",
              "Delete conversation"
            };
    new AlertDialog.Builder(this)
        .setTitle("LINA")
        .setItems(
            items,
            (d, w) -> {
              switch (items[w]) {
                case "Connection":
                  showConnection();
                  break;
                case "New conversation":
                  newSession();
                  break;
                case "Add project":
                  addProject();
                  break;
                case "Agent activity":
                  activity();
                  break;
                case "Session controls":
                  controls();
                  break;
                case "Candidate comparison":
                  candidates();
                  break;
                case "Changes and undo":
                  changes();
                  break;
                case "Files":
                  files();
                  break;
                case "Search conversations":
                  search();
                  break;
                case "Previews":
                  previews();
                  break;
                case "Findings":
                  findings();
                  break;
                case "Models and mode":
                  models();
                  break;
                case "Settings":
                  settings();
                  break;
                case "Open web interface":
                  openWeb();
                  break;
                case "Delete conversation":
                  final String deleteId = sessionId;
                  confirm(
                      "Delete conversation?",
                      "This deletes Lina's record and isolated workspace. Direct project files are"
                          + " preserved.",
                      () -> mutateFor(deleteId, "DELETE", "?confirm=1", null, true));
                  break;
              }
            })
        .show();
  }

  private void controls() {
    if (snapshot == null) return;
    final String id = sessionId;
    String state = snapshot.optJSONObject("session").optString("status");
    ArrayList<String> options = new ArrayList<>();
    if (state.equals("running")) {
      options.add("Pause");
      options.add("Cancel");
      options.add("Interrupt with draft");
    } else {
      if (state.equals("paused")
          || state.equals("interrupted")
          || state.equals("cancelled")
          || state.equals("failed")) options.add("Resume");
      if (!state.equals("idle") && !state.equals("rejected")) options.add("Review");
      if (state.equals("failed")) options.add("Retry");
    }
    if (state.equals("awaiting_approval")) {
      options.add("Approve squash");
      options.add("Approve merge");
      options.add("Keep branch");
      options.add("Reject");
      if (snapshot
          .optJSONObject("session")
          .optJSONObject("config")
          .optString("mode")
          .equals("compete")) {
        options.add("Choose Codex");
        options.add("Choose Claude");
      }
    }
    new AlertDialog.Builder(this)
        .setTitle("Session controls")
        .setItems(
            options.toArray(new String[0]),
            (d, w) -> {
              String a = options.get(w);
              if (a.equals("Interrupt with draft")) {
                if (same(id, sessionId)) sendMessage(true);
                return;
              }
              if (a.startsWith("Approve") || a.equals("Keep branch"))
                confirm(
                    a + "?",
                    "Apply this isolated session's result to the host repository.",
                    () ->
                        mutateFor(
                            id,
                            "POST",
                            "/approval",
                            json(
                                "decision",
                                "approve",
                                "strategy",
                                a.equals("Keep branch")
                                    ? "branch"
                                    : a.endsWith("merge") ? "merge" : "squash"),
                            false));
              else if (a.startsWith("Choose"))
                mutateFor(
                    id,
                    "POST",
                    "/approval",
                    json("decision", "choose", "variant", a.endsWith("Codex") ? "codex" : "claude"),
                    false);
              else if (a.equals("Reject"))
                confirm(
                    "Reject result?",
                    "Keep the workspace but mark this result rejected.",
                    () -> mutateFor(id, "POST", "/approval", json("decision", "reject"), false));
              else
                mutateFor(
                    id,
                    "POST",
                    "/control",
                    json("action", a.toLowerCase(java.util.Locale.ROOT)),
                    false);
            })
        .setNegativeButton("Close", null)
        .show();
  }

  private void mutate(String method, String suffix, JSONObject data, boolean leave) {
    mutateFor(sessionId, method, suffix, data, leave);
  }

  private void mutateFor(String id, String method, String suffix, JSONObject data, boolean leave) {
    if (!same(id, sessionId)) {
      alert("Conversation changed", "Reopen this action in the current conversation.");
      return;
    }
    async(
        client ->
            client.request(
                method, "/api/sessions/" + id + suffix, data == null ? null : data.toString()),
        value -> {
          if (!same(id, sessionId)) return;
          if (leave) leaveSession();
          else refresh(true);
        },
        false);
  }

  private void activity() {
    if (snapshot == null) return;
    activityOffset = 0;
    LinearLayout form = column();
    LinearLayout filters = row();
    for (String name : new String[] {"all", "codex", "claude"}) {
      filters.addView(
          button(
              name.equals("all") ? "All agents" : name,
              v -> {
                agentFilter = name;
                updateActivity();
              }));
    }
    form.addView(filters);
    LinearLayout paging = row();
    paging.addView(
        button(
            "Newer activity",
            v -> {
              activityOffset = Math.max(0, activityOffset - 100);
              updateActivity();
              liveScroll.scrollTo(0, 0);
            }));
    paging.addView(
        button(
            "Older activity",
            v -> {
              activityOffset += 100;
              updateActivity();
              liveScroll.scrollTo(0, 0);
            }));
    form.addView(paging);
    ScrollView scroller = new ScrollView(this);
    liveScroll = scroller;
    liveDetails = label("", 14);
    liveDetails.setTextIsSelectable(true);
    liveDetails.setPadding(dp(16), dp(8), dp(16), dp(8));
    scroller.addView(liveDetails);
    form.addView(scroller, new LinearLayout.LayoutParams(-1, dp(400)));
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Live agent activity")
            .setView(form)
            .setPositiveButton("Close", null)
            .create();
    dialog.setOnDismissListener(d -> liveDetails = null);
    updateActivity();
    dialog.show();
  }

  private void updateActivity() {
    if (liveDetails == null || snapshot == null) return;
    StringBuilder text = new StringBuilder(agentStatus.getText()).append("\n\n");
    JSONObject live = snapshot.optJSONObject("live");
    JSONObject streams = live == null ? null : live.optJSONObject("streams");
    if (streams != null && activityOffset == 0) {
      java.util.Iterator<String> keys = streams.keys();
      while (keys.hasNext()) {
        JSONObject stream = streams.optJSONObject(keys.next());
        if (stream != null
            && (agentFilter.equals("all") || agentFilter.equals(stream.optString("agent"))))
          text.append(stream.optString("agent"))
              .append(" · Writing now\n")
              .append(stream.optString("text"))
              .append("\n\n");
      }
    }
    JSONArray events = snapshot.optJSONArray("events");
    int shown = 0, matching = 0;
    if (events != null)
      for (int i = events.length() - 1; i >= 0; i--) {
        JSONObject event = events.optJSONObject(i);
        if (event == null) continue;
        JSONObject data = event.optJSONObject("data");
        if (data == null
            || (!agentFilter.equals("all")
                && !agentFilter.equals(event.optString("actor"))
                && !agentFilter.equals(data.optString("agent")))) continue;
        boolean activity = event.optString("type").equals("activity");
        boolean message =
            event.optString("type").equals("message") && !event.optString("actor").equals("user");
        if (!activity && !message) continue;
        if (matching++ < activityOffset) continue;
        if (activity) {
          text.append(data.optString("agent"))
              .append(" · ")
              .append(data.optString("source"))
              .append(" · ")
              .append(data.optString("state"))
              .append("\n")
              .append(data.optString("title"))
              .append("\n")
              .append(data.optString("detail"))
              .append("\n")
              .append(data.optString("output"))
              .append("\n\n");
        } else if (event.optString("type").equals("message")
            && !event.optString("actor").equals("user")) {
          text.append(event.optString("actor"))
              .append(" · Latest update\n")
              .append(data.optString("text"))
              .append("\n\n");
        } else continue;
        if (++shown >= 100) {
          text.append("Use Older activity to inspect earlier records.\n");
          break;
        }
      }
    if (shown == 0 && activityOffset > 0) {
      if (hasEarlier && !earlierLoading) {
        text.append("Loading earlier activity…");
        loadEarlier();
      } else if (!hasEarlier) {
        activityOffset = Math.max(0, matching - 1) / 100 * 100;
        updateActivity();
        return;
      }
    }
    String next = text.toString();
    if (!next.contentEquals(liveDetails.getText())) liveDetails.setText(next);
  }

  private void findings() {
    if (snapshot == null) return;
    final String id = sessionId;
    final JSONArray findings = snapshot.optJSONArray("findings");
    if (findings == null || findings.length() == 0) {
      details("Review findings", "No findings.");
      return;
    }
    String[] names = new String[findings.length()];
    for (int i = 0; i < names.length; i++) {
      JSONObject f = findings.optJSONObject(i);
      names[i] =
          f.optString("id")
              + " · "
              + f.optString("severity")
              + " · "
              + f.optString("status")
              + "\n"
              + f.optString("title");
    }
    new AlertDialog.Builder(this)
        .setTitle("Review findings")
        .setItems(
            names,
            (d, w) -> {
              JSONObject finding = findings.optJSONObject(w);
              AlertDialog.Builder detail =
                  detailDialog(
                      finding.optString("id") + " · " + finding.optString("title"),
                      finding.optString("detail")
                          + "\n"
                          + finding.optString("file")
                          + ":"
                          + finding.optString("line")
                          + "\n"
                          + finding.optString("suggestion"));
              if (finding.optString("status").equals("escalated")
                  || finding.optString("status").equals("open")
                  || finding.optString("status").equals("disputed")
                  || finding.optString("status").equals("fixed"))
                detail.setNeutralButton(
                    "Waive finding",
                    (a, k) ->
                        confirm(
                            "Waive " + finding.optString("id") + "?",
                            "Accept this finding without a code fix. The decision is recorded in"
                                + " the review history.",
                            () ->
                                mutateFor(
                                    id,
                                    "POST",
                                    "/approval",
                                    json("decision", "waive", "findingId", finding.optString("id")),
                                    false)));
              detail.show();
            })
        .setNegativeButton("Close", null)
        .show();
  }

  private void candidates() {
    if (snapshot == null) return;
    JSONArray events = snapshot.optJSONArray("events");
    JSONArray choices = null;
    if (events != null)
      for (int i = events.length() - 1; i >= 0; i--) {
        JSONObject e = events.optJSONObject(i);
        if (e != null && e.optString("type").equals("approval")) {
          choices = e.optJSONObject("data").optJSONArray("candidates");
          if (choices != null) break;
        }
      }
    if (choices == null || choices.length() == 0) {
      details(
          "Candidate comparison",
          "Compete sessions show measured candidate results here after both agents finish. Inspect"
              + " candidate file patches from Changes and undo.");
      return;
    }
    StringBuilder text = new StringBuilder();
    for (int i = 0; i < choices.length(); i++) {
      JSONObject c = choices.optJSONObject(i);
      JSONObject tests = c.optJSONObject("tests"), usage = c.optJSONObject("usage");
      text.append(c.optString("agent"))
          .append("\n")
          .append(c.optInt("files"))
          .append(" files · +")
          .append(c.optInt("additions"))
          .append(" / −")
          .append(c.optInt("deletions"))
          .append("\n")
          .append("Blocking findings: ")
          .append(c.optInt("blockingFindings"))
          .append(" · Review: ")
          .append(c.optString("verdict"))
          .append("\n");
      if (tests != null)
        text.append("Tests: ")
            .append(tests.optString("command"))
            .append(" · exit ")
            .append(tests.optString("exitCode"))
            .append("\n")
            .append(tests.optString("output"))
            .append("\n");
      if (usage != null)
        text.append("Tokens: ")
            .append(usage.optLong("inputTokens") + usage.optLong("outputTokens"))
            .append(" · reported cost $")
            .append(usage.optDouble("costUsd"))
            .append("\n");
      text.append("\n");
    }
    details("Candidate comparison", text.toString());
  }

  private void changes() {
    final String id = sessionId;
    async(
        client -> new JSONArray(client.request("GET", "/api/sessions/" + id + "/changes", null)),
        value -> {
          JSONArray list = (JSONArray) value;
          JSONObject variants =
              snapshot == null ? null : snapshot.optJSONObject("session").optJSONObject("variants");
          ArrayList<String> candidateAgents = new ArrayList<>();
          if (variants != null)
            for (String agent : new String[] {"codex", "claude"})
              if (variants.has(agent)) candidateAgents.add(agent);
          int offset = 1 + candidateAgents.size();
          String[] names = new String[list.length() + offset];
          names[0] = "Current session diff";
          for (int i = 0; i < candidateAgents.size(); i++)
            names[i + 1] = candidateAgents.get(i) + " candidate diff";
          for (int i = 0; i < list.length(); i++) {
            JSONObject t = list.getJSONObject(i);
            names[i + offset] =
                "Turn "
                    + t.optInt("turn")
                    + " · "
                    + t.optString("agent")
                    + " · "
                    + t.optString("status");
          }
          new AlertDialog.Builder(this)
              .setTitle("Changes")
              .setItems(
                  names,
                  (d, w) -> {
                    JSONObject turn = w < offset ? null : list.optJSONObject(w - offset);
                    String suffix = turn == null ? "/diff" : "/changes/" + turn.optInt("turn");
                    if (w > 0 && w < offset) suffix = "/diff?variant=" + candidateAgents.get(w - 1);
                    final String path = suffix;
                    async(
                        client ->
                            new JSONObject(
                                client.request("GET", "/api/sessions/" + id + path, null)),
                        result -> {
                          JSONObject diff = (JSONObject) result;
                          JSONArray files = diff.optJSONArray("files");
                          StringBuilder patches = new StringBuilder();
                          if (files != null)
                            for (int f = 0; f < files.length(); f++) {
                              JSONObject file = files.getJSONObject(f);
                              patches
                                  .append(file.optString("path"))
                                  .append("\n")
                                  .append(file.optString("patch"))
                                  .append("\n");
                            }
                          AlertDialog.Builder b =
                              detailDialog(
                                  "Changes",
                                  patches.length() == 0 ? "No file changes." : patches.toString());
                          if (turn != null && turn.optString("status").equals("ready"))
                            b.setNeutralButton(
                                "Undo turn",
                                (a, k) ->
                                    confirm(
                                        "Undo turn " + turn.optInt("turn") + "?",
                                        "Restore this turn's files if no later edits conflict.",
                                        () ->
                                            mutateFor(
                                                id,
                                                "POST",
                                                "/undo",
                                                json("turn", turn.optInt("turn")),
                                                false)));
                          b.show();
                        },
                        false);
                  })
              .setNegativeButton("Close", null)
              .show();
        },
        false);
  }

  private void files() {
    final String id = sessionId;
    async(
        client -> new JSONArray(client.request("GET", "/api/sessions/" + id + "/tree", null)),
        result -> {
          JSONArray tree = (JSONArray) result;
          ArrayList<String> names = new ArrayList<>();
          for (int i = 0; i < tree.length(); i++) {
            JSONObject file = tree.optJSONObject(i);
            if (file != null && file.optString("type").equals("file"))
              names.add(file.optString("path"));
          }
          if (names.isEmpty()) {
            details("Project files", "No files in this workspace.");
            return;
          }
          new AlertDialog.Builder(this)
              .setTitle("Project files")
              .setItems(
                  names.toArray(new String[0]),
                  (d, w) -> {
                    String path = names.get(w);
                    async(
                        client ->
                            new JSONObject(
                                client.request(
                                    "GET",
                                    "/api/sessions/"
                                        + id
                                        + "/file?path="
                                        + URLEncoder.encode(path, "UTF-8"),
                                    null)),
                        value -> {
                          JSONObject file = (JSONObject) value;
                          details(
                              path,
                              file.optBoolean("binary")
                                  ? "Binary file"
                                  : file.optString("content")
                                      + (file.optBoolean("truncated") ? "\n[File truncated]" : ""));
                        },
                        false);
                  })
              .setNegativeButton("Close", null)
              .show();
        },
        false);
  }

  private void search() {
    EditText query = input("Search conversation messages", false);
    new AlertDialog.Builder(this)
        .setTitle("Search conversations")
        .setView(query)
        .setNegativeButton("Cancel", null)
        .setPositiveButton(
            "Search",
            (d, w) -> {
              String text = query.getText().toString().trim();
              if (text.isEmpty()) return;
              async(
                  client ->
                      new JSONArray(
                          client.request(
                              "GET", "/api/search?q=" + URLEncoder.encode(text, "UTF-8"), null)),
                  result -> {
                    JSONArray hits = (JSONArray) result;
                    if (hits.length() == 0) {
                      details("Search results", "No matching conversations.");
                      return;
                    }
                    String[] names = new String[hits.length()];
                    for (int i = 0; i < names.length; i++) {
                      JSONObject hit = hits.optJSONObject(i);
                      names[i] =
                          hit.optString("sessionTitle")
                              + "\n"
                              + hit.optString("snippet").replaceAll("<[^>]*>", "");
                    }
                    new AlertDialog.Builder(this)
                        .setTitle("Search results")
                        .setItems(
                            names,
                            (a, k) -> {
                              String id = hits.optJSONObject(k).optString("sessionId");
                              Runnable open =
                                  () -> {
                                    openSession(id);
                                    targetEvent = hits.optJSONObject(k).optLong("seq");
                                  };
                              if (!composer.getText().toString().isEmpty()
                                  || !attachments.isEmpty()
                                  || uploading > 0)
                                confirm(
                                    "Discard this draft?",
                                    "Open the matching conversation and discard your unsent"
                                        + " message.",
                                    open);
                              else open.run();
                            })
                        .setNegativeButton("Close", null)
                        .show();
                  },
                  false);
            })
        .show();
  }

  private void previews() {
    final String id = sessionId;
    async(
        client -> new JSONArray(client.request("GET", "/api/sessions/" + id + "/previews", null)),
        value -> {
          JSONArray list = (JSONArray) value;
          String[] names = new String[list.length() + 1];
          names[0] = "Start preview";
          for (int i = 0; i < list.length(); i++) {
            JSONObject p = list.getJSONObject(i);
            names[i + 1] = p.optString("status") + " · " + p.optString("command");
          }
          new AlertDialog.Builder(this)
              .setTitle("Previews")
              .setItems(
                  names,
                  (d, w) -> {
                    if (w == 0) {
                      EditText command =
                          input("Foreground command, e.g. npm run dev -- --port {port}", false);
                      new AlertDialog.Builder(this)
                          .setTitle("Start preview on host")
                          .setView(command)
                          .setPositiveButton(
                              "Start",
                              (a, k) ->
                                  mutateFor(
                                      id,
                                      "POST",
                                      "/previews",
                                      json("command", command.getText().toString()),
                                      false))
                          .setNegativeButton("Cancel", null)
                          .show();
                      return;
                    }
                    JSONObject p = list.optJSONObject(w - 1);
                    async(
                        client ->
                            new JSONObject(
                                client.request(
                                    "GET",
                                    "/api/sessions/"
                                        + id
                                        + "/previews/"
                                        + p.optString("id")
                                        + "/logs",
                                    null)),
                        result -> {
                          AlertDialog.Builder b =
                              detailDialog(
                                  "Preview",
                                  p.optString("url")
                                      + "\nForward this port through SSH for phone access.\n"
                                      + ((JSONObject) result).optString("output"));
                          if (p.optString("status").equals("running")
                              || p.optString("status").equals("starting"))
                            b.setNeutralButton(
                                "Stop",
                                (a, k) ->
                                    mutateFor(
                                        id,
                                        "POST",
                                        "/previews/" + p.optString("id") + "/stop",
                                        json(),
                                        false));
                          b.show();
                        },
                        false);
                  })
              .setNegativeButton("Close", null)
              .show();
        },
        false);
  }

  private void models() {
    if (snapshot == null) return;
    final String id = sessionId;
    JSONObject config = snapshot.optJSONObject("session").optJSONObject("config");
    JSONObject existing = config.optJSONObject("models");
    LinearLayout form = column();
    EditText codex = input("Codex model", false), claude = input("Claude model", false);
    codex.setText(existing.optJSONObject("codex").optString("model"));
    claude.setText(existing.optJSONObject("claude").optString("model"));
    String[] efforts =
        new String[] {"provider default", "low", "medium", "high", "xhigh", "max", "ultra"};
    Spinner codexEffort = spinner(efforts), claudeEffort = spinner(efforts);
    select(codexEffort, existing.optJSONObject("codex").optString("effort", "provider default"));
    select(claudeEffort, existing.optJSONObject("claude").optString("effort", "provider default"));
    form.addView(label("Codex model", 13));
    form.addView(codex);
    modelActions(form, "codex", codex);
    form.addView(label("Codex effort", 13));
    form.addView(codexEffort);
    form.addView(label("Claude model", 13));
    form.addView(claude);
    modelActions(form, "claude", claude);
    form.addView(label("Claude effort", 13));
    form.addView(claudeEffort);
    boolean isolated = !config.optString("workspaceMode").equals("direct");
    CheckBox workflow =
        check(
            isolated ? "Structured workflow (required for isolation)" : "Structured workflow",
            isolated || config.optString("interactionMode").equals("workflow"));
    workflow.setEnabled(!isolated);
    form.addView(workflow);
    ScrollView scroller = new ScrollView(this);
    scroller.addView(form);
    new AlertDialog.Builder(this)
        .setTitle("Next-turn models")
        .setView(scroller)
        .setNegativeButton("Cancel", null)
        .setPositiveButton(
            "Save",
            (d, w) -> {
              JSONObject codexChoice = json("model", codex.getText().toString().trim()),
                  claudeChoice = json("model", claude.getText().toString().trim());
              if (!codexEffort.getSelectedItem().equals("provider default"))
                put(codexChoice, "effort", codexEffort.getSelectedItem());
              if (!claudeEffort.getSelectedItem().equals("provider default"))
                put(claudeChoice, "effort", claudeEffort.getSelectedItem());
              mutateFor(
                  id,
                  "PATCH",
                  "",
                  json(
                      "config",
                      json(
                          "models",
                          json("codex", codexChoice, "claude", claudeChoice),
                          "interactionMode",
                          workflow.isChecked() ? "workflow" : "chat")),
                  false);
            })
        .show();
  }

  private void modelActions(LinearLayout form, String agent, EditText input) {
    LinearLayout actions = row();
    Button choose = button("Choose " + agent + " model", null), validate = button("Validate", null);
    TextView result = label("", 12);
    choose.setOnClickListener(
        v -> {
          choose.setEnabled(false);
          setText(result, "Loading provider model catalogue…");
          final ApiClient client = api;
          final int epoch = generation;
          io.execute(
              () -> {
                JSONObject catalogue = null;
                Exception error = null;
                try {
                  catalogue =
                      new JSONObject(client.request("GET", "/api/models", null))
                          .optJSONObject(agent);
                } catch (Exception e) {
                  error = e;
                }
                final JSONObject value = catalogue;
                final Exception problem = error;
                handler.post(
                    () -> {
                      if (epoch != generation || isDestroyed() || !choose.isAttachedToWindow())
                        return;
                      choose.setEnabled(true);
                      setText(result, "");
                      if (problem != null) {
                        alert("Could not load models", error(problem));
                        return;
                      }
                      JSONArray choices = value == null ? null : value.optJSONArray("models");
                      if (choices == null || choices.length() == 0) {
                        alert(
                            "No provider models",
                            value == null
                                ? "You can enter a custom model ID."
                                : value.optString(
                                    "error",
                                    "No catalogue available. You can enter a custom model ID."));
                        return;
                      }
                      String[] names = new String[choices.length()];
                      for (int i = 0; i < names.length; i++) {
                        JSONObject model = choices.optJSONObject(i);
                        JSONObject validation = model.optJSONObject("validation");
                        names[i] =
                            model.optString("label", model.optString("id"))
                                + "\n"
                                + model.optString("id")
                                + (validation == null
                                    ? " · unvalidated"
                                    : validation.optBoolean("ok")
                                        ? " · validated"
                                        : " · validation failed");
                      }
                      new AlertDialog.Builder(this)
                          .setTitle(agent + " models")
                          .setItems(
                              names,
                              (d, w) -> input.setText(choices.optJSONObject(w).optString("id")))
                          .setNegativeButton("Cancel", null)
                          .show();
                    });
              });
        });
    validate.setOnClickListener(
        v -> {
          String model = input.getText().toString().trim();
          if (model.isEmpty()) {
            input.setError("Enter or choose a model");
            return;
          }
          validate.setEnabled(false);
          setText(result, "Validating with " + agent + "…");
          final ApiClient client = api;
          final int epoch = generation;
          io.execute(
              () -> {
                JSONObject checked = null;
                Exception error = null;
                try {
                  checked =
                      new JSONObject(
                          client.request(
                              "POST",
                              "/api/models/validate",
                              json("agent", agent, "model", model).toString()));
                } catch (Exception e) {
                  error = e;
                }
                final JSONObject value = checked;
                final Exception problem = error;
                handler.post(
                    () -> {
                      if (epoch != generation || isDestroyed() || !validate.isAttachedToWindow())
                        return;
                      validate.setEnabled(true);
                      setText(
                          result,
                          problem != null
                              ? error(problem)
                              : value.optBoolean("ok")
                                  ? "Validated · " + value.optString("resolvedModel", model)
                                  : "Validation failed: " + value.optString("error"));
                    });
              });
        });
    actions.addView(choose);
    actions.addView(validate);
    form.addView(actions);
    form.addView(result);
  }

  private void settings() {
    async(
        client -> new JSONObject(client.request("GET", "/api/settings", null)),
        value -> {
          JSONObject s = (JSONObject) value;
          LinearLayout form = column();
          Switch full = new Switch(this);
          full.setText("Full developer access");
          full.setTextColor(FG);
          full.setChecked(s.optString("accessMode").equals("full"));
          form.addView(full);
          form.addView(
              label(
                  "Full access permits agents and tests to use the host's files, commands and"
                      + " network without prompts.",
                  14));
          new AlertDialog.Builder(this)
              .setTitle("Host settings")
              .setView(form)
              .setNegativeButton("Cancel", null)
              .setPositiveButton(
                  "Save",
                  (d, w) ->
                      async(
                          client ->
                              client.request(
                                  "PUT",
                                  "/api/settings",
                                  json("accessMode", full.isChecked() ? "full" : "restricted")
                                      .toString()),
                          v -> {},
                          false))
              .show();
        },
        false);
  }

  private void openWeb() {
    if (api == null) {
      showConnection();
      return;
    }
    String token =
        automatic == null ? prefs.getString("token", "") : automatic.tokenFor(api.connection);
    String url = api.connection.origin + (token.isEmpty() ? "" : "#token=" + Uri.encode(token));
    startActivity(
        new Intent(this, AdvancedWebActivity.class)
            .putExtra("url", url)
            .putExtra("certificateSha256", api.connection.certificateSha256));
  }

  private void showConnection() {
    LinearLayout form = column();
    form.setPadding(dp(16), 0, dp(16), 0);
    TextView help =
        label(
            automatic == null
                ? "Connect once. Your conversations and drafts stay with you."
                : automatic.description(),
            14);
    help.setTextColor(MUTED);
    help.setLineSpacing(dp(3), 1);
    help.setPadding(0, dp(4), 0, dp(14));
    form.addView(help);
    if (automatic == null) {
      TextView setup =
          label("On your PC, run lina tailscale on and paste its HTTPS address below.", 13);
      setup.setTextColor(MUTED);
      setup.setPadding(0, 0, 0, dp(8));
      form.addView(setup);
    }
    Button retry = button("Retry automatically", v -> {});
    if (automatic != null) form.addView(retry);
    EditText address = input("LINA address", false), token = input("Token (SSH only)", true);
    address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    address.setText(prefs.getString("origin", ""));
    form.addView(address);
    TextView ssh = label("Use an SSH tunnel", 13);
    ssh.setTextColor(Design.ACCENT);
    ssh.setPadding(0, dp(10), 0, dp(10));
    form.addView(ssh);
    form.addView(token);
    token.setVisibility(
        prefs.getString("origin", "").startsWith("http:") ? View.VISIBLE : View.GONE);
    ssh.setOnClickListener(
        v -> {
          token.setVisibility(token.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        });
    address.addTextChangedListener(
        new TextWatcher() {
          public void beforeTextChanged(CharSequence t, int start, int count, int after) {}

          public void onTextChanged(CharSequence t, int start, int before, int count) {
            if (t.toString().trim().startsWith("http:")) token.setVisibility(View.VISIBLE);
          }

          public void afterTextChanged(Editable e) {}
        });
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Connect to LINA")
            .setView(form)
            .setNegativeButton("Cancel", null)
            .setNeutralButton("Forget device", (a, k) -> forget())
            .setPositiveButton("Connect", null)
            .create();
    retry.setOnClickListener(
        v -> {
          if (automatic != null) automatic.retry();
          d.dismiss();
        });
    d.setOnShowListener(
        v ->
            d.getButton(-1)
                .setOnClickListener(
                    w -> {
                      try {
                        Connection next = new Connection(address.getText().toString());
                        String secret = token.getText().toString().trim();
                        if (secret.isEmpty()) {
                          String fragment = new java.net.URI(next.url).getRawFragment();
                          if (fragment != null)
                            for (String p : fragment.split("&")) {
                              String[] kv = p.split("=", 2);
                              if (kv.length == 2 && kv[0].equals("token"))
                                secret = URLDecoder.decode(kv[1], "UTF-8");
                            }
                          if (secret.isEmpty() && next.origin.equals(prefs.getString("origin", "")))
                            secret = prefs.getString("token", "");
                        }
                        if (secret.contains("\r") || secret.contains("\n"))
                          throw new IllegalArgumentException("Invalid token");
                        final String credential = secret;
                        boolean changingHost =
                            !next.origin.equals(prefs.getString("origin", next.origin));
                        Runnable apply =
                            () -> {
                              generation++;
                              earlierLoading = false;
                              hasEarlier = false;
                              cursor = 0;
                              polling = false;
                              uploading = 0;
                              updateSendState();
                              api = new ApiClient(next, credential);
                              if (changingHost) prefs.edit().remove("routes").apply();
                              prefs
                                  .edit()
                                  .putString("origin", next.origin)
                                  .putString("token", credential)
                                  .apply();
                              snapshot = null;
                              contentKey = "";
                              if (changingHost) {
                                sessionId = null;
                                sessions = new JSONArray();
                                composer.setText("");
                                attachments.clear();
                                prefs
                                    .edit()
                                    .remove("session")
                                    .remove("draftSession")
                                    .remove("draft")
                                    .remove("draftAttachments")
                                    .apply();
                              }
                              address.setText("");
                              token.setText("");
                              d.dismiss();
                              if (sessionId == null) home();
                              else updateAttachments();
                              startAutomaticConnection();
                            };
                        if (changingHost
                            && (!composer.getText().toString().isEmpty()
                                || !attachments.isEmpty()
                                || uploading > 0))
                          confirm(
                              "Switch LINA host?",
                              "Your unsent message and files belong to this host and will be"
                                  + " discarded.",
                              apply);
                        else apply.run();
                      } catch (Exception e) {
                        address.setError(e.getMessage());
                      }
                    }));
    d.show();
    if (prefs.getString("origin", null) == null)
      d.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.GONE);
  }

  private void forget() {
    if (automatic != null) automatic.close();
    automatic = null;
    generation++;
    transportGeneration++;
    earlierLoading = false;
    hasEarlier = false;
    cursor = 0;
    targetEvent = 0;
    uploading = 0;
    updateSendState();
    polling = false;
    api = null;
    sessionId = null;
    snapshot = null;
    sessions = new JSONArray();
    attachments.clear();
    composer.setText("");
    prefs.edit().clear().apply();
    getSharedPreferences("web_connection", MODE_PRIVATE).edit().clear().apply();
    try {
      android.webkit.WebStorage.getInstance().deleteAllData();
      android.webkit.CookieManager.getInstance().removeAllCookies(null);
    } catch (RuntimeException ignored) {
      /* Native client also works without a WebView provider. */
    }
    setText(connectionStatus, "This device is forgotten.");
    home();
  }

  private LinearLayout column() {
    LinearLayout l = new LinearLayout(this);
    l.setOrientation(LinearLayout.VERTICAL);
    return l;
  }

  private LinearLayout row() {
    LinearLayout l = new LinearLayout(this);
    l.setGravity(Gravity.CENTER_VERTICAL);
    return l;
  }

  private void setText(TextView view, CharSequence text) {
    if (!text.toString().contentEquals(view.getText())) view.setText(text);
    if (view == connectionStatus)
      view.setTextColor(text.toString().contains("Connected") ? Design.GREEN : MUTED);
  }

  private TextView label(String text, int size) {
    TextView t = new TextView(this);
    t.setText(text);
    t.setTextColor(FG);
    t.setTextSize(size);
    t.setFontFeatureSettings("kern");
    t.setIncludeFontPadding(false);
    return t;
  }

  private Button button(String text, View.OnClickListener action) {
    Button b = new Button(this);
    b.setText(text);
    Design.button(b, false);
    b.setContentDescription(text);
    b.setOnClickListener(action);
    return b;
  }

  private EditText input(String hint, boolean password) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setContentDescription(hint);
    e.setTextColor(FG);
    e.setHintTextColor(MUTED);
    e.setSingleLine(true);
    e.setTextSize(15);
    e.setPadding(dp(14), dp(12), dp(14), dp(12));
    e.setBackground(Design.shape(this, Design.SURFACE, 12, Design.BORDER));
    e.setMinHeight(dp(48));
    LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, -2);
    space.topMargin = dp(6);
    space.bottomMargin = dp(8);
    e.setLayoutParams(space);
    e.setSaveEnabled(false);
    if (password)
      e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    return e;
  }

  private Spinner spinner(String[] values) {
    Spinner s = new Spinner(this);
    s.setAdapter(
        new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, values));
    return s;
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private static JSONObject json(Object... pairs) {
    JSONObject j = new JSONObject();
    try {
      for (int i = 0; i < pairs.length; i += 2) j.put((String) pairs[i], pairs[i + 1]);
    } catch (Exception e) {
      throw new IllegalArgumentException(e);
    }
    return j;
  }

  private void alert(String title, String message) {
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setMessage(message)
        .setPositiveButton("Close", null)
        .show();
  }

  private AlertDialog.Builder detailDialog(String title, String text) {
    ScrollView s = new ScrollView(this);
    TextView t = label(text, 14);
    t.setPadding(dp(16), dp(8), dp(16), dp(8));
    t.setTextIsSelectable(true);
    s.addView(t);
    return new AlertDialog.Builder(this)
        .setTitle(title)
        .setView(s)
        .setPositiveButton("Close", null);
  }

  private void details(String title, String text) {
    detailDialog(title, text).show();
  }

  private void confirm(String title, String text, Runnable action) {
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setMessage(text)
        .setNegativeButton("Cancel", null)
        .setPositiveButton("Continue", (d, w) -> action.run())
        .show();
  }

  private void back() {
    if (sessionId != null) showSessions();
    else finish();
  }

  @Override
  public void onBackPressed() {
    back();
  }

  @Override
  protected void onResume() {
    super.onResume();
    foreground = true;
    if (automatic != null) automatic.resume();
    if (api != null && prefs.getString("origin", null) == null) {
      api = null;
      sessionId = null;
      home();
    }
    handler.removeCallbacks(ticker);
    handler.post(ticker);
  }

  @Override
  protected void onPause() {
    foreground = false;
    if (automatic != null) automatic.pause();
    handler.removeCallbacks(ticker);
    saveDraft();
    super.onPause();
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    state.putString("session", sessionId);
    state.putString("fileSession", fileSession);
    state.putString("draft", composer.getText().toString());
    state.putString("attachments", attachmentJson());
    super.onSaveInstanceState(state);
  }

  @Override
  protected void onDestroy() {
    if (automatic != null) automatic.close();
    generation++;
    handler.removeCallbacksAndMessages(null);
    io.shutdownNow();
    super.onDestroy();
  }
}
