package app.liubai.social;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
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

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(android.graphics.Color.rgb(246, 246, 244));
        window.setNavigationBarColor(android.graphics.Color.rgb(255, 255, 255));
        window.getDecorView().setSystemUiVisibility(ViewFlags.LIGHT_STATUS_BAR | ViewFlags.LIGHT_NAVIGATION_BAR);

        webView = new WebView(this);
        webView.setBackgroundColor(android.graphics.Color.rgb(246, 246, 244));
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
            view.setPadding(0, top, 0, bottom);
            return insets;
        });
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(true);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                try { startActivityForResult(intent, FILE_PICKER); }
                catch (Exception error) { fileCallback = null; return false; }
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

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_PICKER && fileCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            fileCallback.onReceiveValue(results);
            fileCallback = null;
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
