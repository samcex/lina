package app.lina.android;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.*;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;

/** Small native visual system. No downloaded fonts, icon libraries, or WebView. */
final class Design {
  static final int BG = Color.rgb(16, 17, 21),
      SURFACE = Color.rgb(25, 27, 33),
      BORDER = Color.rgb(43, 45, 54),
      TEXT = Color.rgb(240, 240, 245),
      MUTED = Color.rgb(148, 151, 164),
      ACCENT = Color.rgb(193, 178, 250),
      GREEN = Color.rgb(132, 210, 176),
      AMBER = Color.rgb(230, 190, 119),
      RED = Color.rgb(213, 145, 153);

  static int dp(Context c, int n) {
    return Math.round(n * c.getResources().getDisplayMetrics().density);
  }

  static GradientDrawable shape(Context c, int fill, int radius, int border) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(fill);
    d.setCornerRadius(dp(c, radius));
    if (border != 0) d.setStroke(dp(c, 1), border);
    return d;
  }

  static Drawable touch(Context c, int fill, int radius, int border) {
    return new RippleDrawable(
        ColorStateList.valueOf(0x22ffffff),
        shape(c, fill, radius, border),
        shape(c, Color.WHITE, radius, 0));
  }

  static void button(Button b, boolean primary) {
    Context c = b.getContext();
    b.setAllCaps(false);
    b.setTextSize(14);
    b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    b.setTextColor(primary ? BG : TEXT);
    b.setBackgroundTintList(null);
    b.setBackground(touch(c, primary ? ACCENT : SURFACE, 12, primary ? 0 : BORDER));
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    b.setMinHeight(dp(c, 44));
    b.setMinimumHeight(dp(c, 44));
    b.setPadding(dp(c, 16), dp(c, 8), dp(c, 16), dp(c, 8));
    b.setElevation(0);
    b.setStateListAnimator(null);
    b.setGravity(Gravity.CENTER);
  }

  static Button icon(Context c, String icon, String description, View.OnClickListener action) {
    Button b = new IconButton(c, icon);
    b.setContentDescription(description);
    b.setOnClickListener(action);
    b.setTooltipText(description);
    return b;
  }

  private static final class IconButton extends Button {
    private final Mark mark;
    private final boolean primary;

    IconButton(Context c, String key) {
      super(c);
      primary = key.equals("send");
      mark = new Mark(c, key, key.equals("send") ? BG : TEXT);
      button(this, false);
      setText("");
      setPadding(0, 0, 0, 0);
      setBackground(touch(c, Color.TRANSPARENT, 12, 0));
    }

    @Override
    protected void onDraw(Canvas canvas) {
      super.onDraw(canvas);
      if (primary && !isEnabled()) {
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setColor(BORDER);
        canvas.drawRoundRect(
            0, 0, getWidth(), getHeight(), dp(getContext(), 14), dp(getContext(), 14), fill);
      }
      int s = dp(getContext(), 22);
      int x = (getWidth() - s) / 2, y = (getHeight() - s) / 2;
      mark.setBounds(x, y, x + s, y + s);
      mark.setAlpha(isEnabled() ? 255 : 80);
      mark.draw(canvas);
    }
  }

  static final class Mark extends Drawable {
    final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    final String key;
    final int size;

    Mark(Context c, String key, int color) {
      this.key = key;
      p.setColor(color);
      size = dp(c, 22);
    }

    @Override
    public int getIntrinsicWidth() {
      return size;
    }

    @Override
    public int getIntrinsicHeight() {
      return size;
    }

    void line(Canvas c, float a, float b, float x, float y) {
      c.drawLine(a, b, x, y, p);
    }

    @Override
    public void draw(Canvas original) {
      Canvas c = original;
      int saved = c.save();
      Rect b = getBounds();
      c.translate(b.left, b.top);
      c.scale(b.width() / 24f, b.height() / 24f);
      p.setStyle(Paint.Style.STROKE);
      p.setStrokeWidth(1.7f);
      p.setStrokeCap(Paint.Cap.ROUND);
      p.setStrokeJoin(Paint.Join.ROUND);
      if (key.equals("back")) {
        line(c, 14, 5, 7, 12);
        line(c, 7, 12, 14, 19);
        line(c, 7, 12, 20, 12);
      } else if (key.equals("plus")) {
        line(c, 12, 5, 12, 19);
        line(c, 5, 12, 19, 12);
      } else if (key.equals("send")) {
        line(c, 12, 19, 12, 5);
        line(c, 6, 11, 12, 5);
        line(c, 12, 5, 18, 11);
      } else if (key.equals("more")) {
        p.setStyle(Paint.Style.FILL);
        for (int y : new int[] {5, 12, 19}) c.drawCircle(12, y, 1.4f, p);
      } else if (key.equals("search")) {
        c.drawCircle(10.5f, 10.5f, 6, p);
        line(c, 15, 15, 20, 20);
      } else if (key.equals("chevron")) {
        line(c, 9, 6, 15, 12);
        line(c, 15, 12, 9, 18);
      } else if (key.equals("files")) {
        c.drawRoundRect(4, 5, 20, 20, 2, 2, p);
        line(c, 4, 10, 20, 10);
        line(c, 9, 5, 9, 10);
      } else if (key.equals("activity")) {
        line(c, 3, 12, 7, 12);
        line(c, 7, 12, 10, 5);
        line(c, 10, 5, 14, 19);
        line(c, 14, 19, 17, 12);
        line(c, 17, 12, 21, 12);
      } else if (key.equals("code")) {
        line(c, 8, 6, 3, 12);
        line(c, 3, 12, 8, 18);
        line(c, 16, 6, 21, 12);
        line(c, 21, 12, 16, 18);
      } else if (key.equals("attach")) {
        Path path = new Path();
        path.moveTo(8, 13);
        path.lineTo(14, 7);
        path.cubicTo(18, 3, 23, 8, 19, 12);
        path.lineTo(10, 21);
        path.cubicTo(4, 27, -2, 18, 4, 12);
        path.lineTo(13, 3);
        c.save();
        c.scale(.78f, .78f, 12, 12);
        c.drawPath(path, p);
        c.restore();
      } else {
        c.drawRoundRect(3, 4, 21, 18, 4, 4, p);
        line(c, 8, 18, 5, 21);
        line(c, 5, 21, 5, 17);
        line(c, 8, 9, 16, 9);
        line(c, 8, 13, 13, 13);
      }
      c.restoreToCount(saved);
    }

    @Override
    public void setAlpha(int alpha) {
      p.setAlpha(alpha);
    }

    @Override
    public void setColorFilter(ColorFilter filter) {
      p.setColorFilter(filter);
    }

    @Override
    public int getOpacity() {
      return PixelFormat.TRANSLUCENT;
    }
  }
}
