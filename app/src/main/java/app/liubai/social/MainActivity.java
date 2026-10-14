package app.liubai.social;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.Window;

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private static final int FILE_PICKER = 4102;
    private int lastStatusBarTop = 0;

    // JS 桥接：把真实状态栏高度写入 CSS 变量 --status-bar-height / --sat。
    // 首页 .topbar 是 position:sticky，sticky 会忽略 WebView 的 View padding，
    // 仍贴到 0，和状态栏重合；而 Android WebView 的 env(safe-area-inset-top)
    // 经常是 0，光靠 CSS 拿不到高度。所以必须由原生把高度灌进网页。
    private void applyStatusBarHeight(int top) {
        if (top <= 0) top = getStatusBarHeight();
        if (top <= 0) return;
        lastStatusBarTop = top;
        if (webView == null) return;
        try {
            webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--status-bar-height','" + top + "px');"
                + "document.documentElement.style.setProperty('--sat','" + top + "px');",
                null);
        } catch (Exception ignored) {}
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(android.graphics.Color.rgb(246, 246, 244));
        window.setNavigationBarColor(android.graphics.Color.rgb(255, 255, 255));
        // Edge-to-edge: 让内容布局到状态栏/导航栏下方，insets 由 WebView 监听处理。
        // 项目无 androidx 依赖，不用 WindowCompat，改用系统 UI 标志兼容写法。
        // Android 15 / targetSdk 36 默认 edge-to-edge，若不声明 LAYOUT_FULLSCREEN，
        // DecorView 可能先消费掉 insets，导致 listener 拿到的 top 为 0、顶栏重合。
        window.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | ViewFlags.LIGHT_STATUS_BAR | ViewFlags.LIGHT_NAVIGATION_BAR);

        webView = new WebView(this);
        webView.setBackgroundColor(android.graphics.Color.rgb(246, 246, 244));
        // 不让 WebView 自身再按 fitsSystemWindows 消费一次，避免与 listener 双重处理。
        webView.setFitsSystemWindows(false);
        webView.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            // 兜底：部分机型/系统上 DecorView 已消费 insets，top 会是 0。
            // 此时用资源里的 status_bar_height，避免顶栏与状态栏重合。
            if (top <= 0) top = getStatusBarHeight();
            view.setPadding(0, top, 0, bottom);
            // 同步把高度灌进网页，供首页 sticky 顶栏的 top / padding 使用。
            applyStatusBarHeight(top);
            return insets;
        });
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 页面加载完后再灌一次：insets 可能在页面加载前就到，
                // 那时 document 还没就绪，变量会丢；此处用已缓存的高度重灌。
                applyStatusBarHeight(lastStatusBarTop > 0 ? lastStatusBarTop : getStatusBarHeight());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    // 显式处理多选：params.createIntent() 在部分机型上多选时返回的 Intent
                    // 不带 EXTRA_ALLOW_MULTIPLE，或 onActivityResult 用 parseResult 拿不到 ClipData，
                    // 导致 input.files 为空，选完又回到原来样子。
                    boolean allowMultiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                    String[] acceptTypes = params.getAcceptTypes();
                    String mime = "*/*";
                    if (acceptTypes != null && acceptTypes.length > 0 && acceptTypes[0] != null && !acceptTypes[0].isEmpty()) {
                        mime = acceptTypes[0];
                    }
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(mime);
                    if (allowMultiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    Intent chooser = Intent.createChooser(intent, "选择文件");
                    startActivityForResult(chooser, FILE_PICKER);
                } catch (Exception error) {
                    if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
                    try { webView.evaluateJavascript("window.__liubaiToast && window.__liubaiToast('无法打开文件选择器，请重试')", null); } catch (Exception ignored) {}
                    return false;
                }
                return true;
            }
        });
        setContentView(webView);
        String appUrl = "file:///android_asset/index.html";
        if (!BuildConfig.LIUBAI_API_URL.isEmpty()) {
            appUrl += "?server=" + Uri.encode(BuildConfig.LIUBAI_API_URL);
        }
        webView.loadUrl(appUrl);
    }

    private int getStatusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (id > 0) {
            try { return getResources().getDimensionPixelSize(id); } catch (Exception ignored) {}
        }
        return 0;
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_PICKER) return;
        if (fileCallback == null) return;
        ValueCallback<Uri[]> cb = fileCallback;
        fileCallback = null;
        if (resultCode != Activity.RESULT_OK || data == null) {
            cb.onReceiveValue(null);
            return;
        }
        try {
            // 手动解析 ClipData + getData，不要只依赖 parseResult（多选时部分机型返回 null）。
            java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                for (int i = 0; i < n; i++) {
                    Uri u = data.getClipData().getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            if (uris.isEmpty()) {
                Uri[] fallback = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                cb.onReceiveValue(fallback);
            } else {
                cb.onReceiveValue(uris.toArray(new Uri[0]));
            }
        } catch (Exception e) {
            cb.onReceiveValue(null);
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    private static final class ViewFlags {
        static final int LIGHT_STATUS_BAR = 0x00002000;
        static final int LIGHT_NAVIGATION_BAR = 0x00000010;
    }
}
