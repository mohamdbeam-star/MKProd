package com.mkoussa.mkprod;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * MK Prod for Android: a full-screen WebView around the web app. Every feature comes from the
 * site; this shell adds a launcher icon, proper handling of folding/unfolding and multi-window
 * (see configChanges in the manifest), file uploads for attachments, downloads of encrypted
 * attachments and Excel exports, and opening external links in the browser.
 */
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 1;
    private WebView web;
    private String origin;
    private ValueCallback<Uri[]> pendingChooser;
    private LinearLayout offline;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String appUrl = getString(R.string.app_url);
        origin = Uri.parse(appUrl).getScheme() + "://" + Uri.parse(appUrl).getHost();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        offline = buildOfflineView();
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Edge to edge: draw under the system bars, then pad the content so nothing hides behind them.
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " MKProdAndroid/" + BuildConfig.VERSION_NAME);
        if (Build.VERSION.SDK_INT >= 33) s.setAlgorithmicDarkeningAllowed(true);
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "MKProdAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(origin)) return false;
                // Supplier pages, SharePoint links, mailto: … go to the system browser / mail app.
                try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) offline.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url.startsWith(origin)) offline.setVisibility(View.GONE);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingChooser != null) pendingChooser.onReceiveValue(null);
                pendingChooser = cb;
                try {
                    startActivityForResult(Intent.createChooser(params.createIntent(), "Attach file"), FILE_CHOOSER);
                } catch (Exception e) {
                    pendingChooser = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny(); // the app never needs camera or microphone
            }
        });

        // Downloads: ordinary URLs through the system download manager; blob: URLs (decrypted
        // attachments, Excel exports) are read in the page and handed over through the bridge.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url.startsWith("blob:")) {
                web.evaluateJavascript(
                    "(async()=>{try{const r=await fetch('" + url + "');const b=await r.blob();const fr=new FileReader();" +
                    "fr.onload=()=>MKProdAndroid.saveBase64(" + json(URLUtil.guessFileName(url, contentDisposition, mimeType)) + ",b.type||'application/octet-stream',fr.result.split(',')[1]);" +
                    "fr.readAsDataURL(b);}catch(e){MKProdAndroid.toast('Download failed: '+e.message)}})()", null);
                return;
            }
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                req.setMimeType(mimeType);
                req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
            } catch (Exception e) {
                Toast.makeText(this, "Download failed", Toast.LENGTH_SHORT).show();
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(targetUrl(getIntent(), appUrl));
    }

    /** Opens an MK Prod link (supplier page, task link) inside the app; anything else, the home page. */
    private String targetUrl(Intent intent, String fallback) {
        Uri data = intent != null ? intent.getData() : null;
        return data != null && data.toString().startsWith(origin) ? data.toString() : fallback;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getData() != null && intent.getData().toString().startsWith(origin)) web.loadUrl(intent.getData().toString());
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || pendingChooser == null) return;
        pendingChooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingChooser = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private LinearLayout buildOfflineView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(android.view.Gravity.CENTER);
        box.setBackgroundColor(getColor(R.color.background));
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText(R.string.offline_title);
        title.setTextSize(22);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        TextView body = new TextView(this);
        body.setText(R.string.offline_body);
        body.setTextSize(15);
        body.setPadding(0, pad / 2, 0, pad);
        body.setGravity(android.view.Gravity.CENTER);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> { offline.setVisibility(View.GONE); web.reload(); });
        box.addView(title);
        box.addView(body);
        box.addView(retry);
        return box;
    }

    private static String json(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** Called from the page (see the download listener) with a file to save into Downloads. */
    private final class Bridge {
        @JavascriptInterface
        public void saveBase64(String name, String mime, String base64) {
            byte[] bytes;
            try { bytes = Base64.decode(base64, Base64.DEFAULT); } catch (Exception e) { toast("Download failed"); return; }
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                        v.put(MediaStore.Downloads.MIME_TYPE, mime);
                        v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                        if (uri == null) throw new IllegalStateException("no uri");
                        try (OutputStream out = getContentResolver().openOutputStream(uri)) { out.write(bytes); }
                        Toast.makeText(MainActivity.this, getString(R.string.saved_to, name), Toast.LENGTH_LONG).show();
                        open(uri, mime);
                    } else {
                        File dir = new File(getExternalFilesDir(null), "Download");
                        dir.mkdirs();
                        File f = new File(dir, name);
                        try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                        Uri uri = FileProvider.getUriForFile(MainActivity.this, "com.mkoussa.mkprod.files", f);
                        Toast.makeText(MainActivity.this, getString(R.string.saved_to, name), Toast.LENGTH_LONG).show();
                        open(uri, mime);
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Could not save " + name, Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
        }

        private void open(Uri uri, String mime) {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try { startActivity(i); } catch (Exception ignored) { /* no viewer for this type: the file is still in Downloads */ }
        }
    }
}
