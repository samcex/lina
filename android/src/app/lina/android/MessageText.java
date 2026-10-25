package app.lina.android;

import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.*;
import java.util.regex.*;

/** Readable native message formatting; text stays selectable and code whitespace is preserved. */
final class MessageText {
  static CharSequence format(String text) {
    SpannableStringBuilder out = new SpannableStringBuilder();
    boolean code = false;
    for (String line : text.split("\n", -1)) {
      if (line.trim().startsWith("```")) {
        code = !code;
        continue;
      }
      int start = out.length();
      if (code) {
        out.append(line);
        span(out, new TypefaceSpan("monospace"), start, out.length());
        span(out, new BackgroundColorSpan(0xff23252e), start, out.length());
        span(out, new RelativeSizeSpan(.88f), start, out.length());
      } else {
        boolean heading = line.matches("^#{1,6} .*"),
            bullet = line.matches("^\\s*[-*] .*"),
            quote = line.startsWith("> ");
        if (heading) line = line.replaceFirst("^#{1,6} +", "");
        else if (bullet) line = line.replaceFirst("^(\\s*)[-*] ", "$1• ");
        else if (quote) line = line.substring(2);
        Matcher m = Pattern.compile("\\*\\*(.+?)\\*\\*|`([^`]+)`").matcher(line);
        int last = 0;
        while (m.find()) {
          out.append(line.substring(last, m.start()));
          int at = out.length();
          out.append(m.group(1) != null ? m.group(1) : m.group(2));
          if (m.group(1) != null) span(out, new StyleSpan(Typeface.BOLD), at, out.length());
          else {
            span(out, new TypefaceSpan("monospace"), at, out.length());
            span(out, new BackgroundColorSpan(0xff292b34), at, out.length());
          }
          last = m.end();
        }
        out.append(line.substring(last));
        if (heading) {
          span(out, new StyleSpan(Typeface.BOLD), start, out.length());
          span(out, new RelativeSizeSpan(1.15f), start, out.length());
        }
        if (quote) {
          span(out, new ForegroundColorSpan(Design.MUTED), start, out.length());
          span(out, new LeadingMarginSpan.Standard(12), start, out.length());
        }
      }
      out.append('\n');
    }
    if (out.length() > 0) out.delete(out.length() - 1, out.length());
    return out;
  }

  private static void span(SpannableStringBuilder b, Object span, int start, int end) {
    if (end > start) b.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
  }
}
