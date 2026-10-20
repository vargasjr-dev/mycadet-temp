package ai.mycadet.android;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.IOException;
import java.io.InputStream;

/**
 * Resolves extension-less routes under {@code /assistant/} to the baked web
 * bundle's {@code index.html}. {@code build:capacitor} copies the
 * clients/web build under {@code public/assistant/}; the boot bundle's
 * {@code /assistant/} handoff and the SPA's client-side routes are
 * extension-less paths under it, and Capacitor's html5 fallback serves the
 * ROOT {@code index.html} — the boot bundle — which would turn the handoff
 * into a boot→handoff→boot loop. The host-API namespaces ({@code __gateway}
 * / {@code __local}) are not SPA routes: they fall through to Capacitor's
 * resolver, which misses the file and fails the request the way a dead host
 * would — exactly the degradation the web layer's error paths expect.
 */
public class AssistantSpaWebViewClient extends BridgeWebViewClient {
    private static final String WEB_ASSET_DIR = "public/assistant/index.html";
    private static final String GATEWAY_NAMESPACE = "/assistant/__gateway/";
    private static final String LOCAL_NAMESPACE = "/assistant/__local/";

    private final Bridge bridge;

    public AssistantSpaWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse baked = interceptAssistantRoute(request.getUrl().getPath());
        if (baked != null) {
            return baked;
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse interceptAssistantRoute(String path) {
        if (path == null || !isWebBundleRoute(path)) {
            return null;
        }
        try {
            InputStream stream = bridge.getContext().getAssets().open(WEB_ASSET_DIR);
            return new WebResourceResponse("text/html", "utf-8", stream);
        } catch (IOException exception) {
            return null;
        }
    }

    private static boolean isWebBundleRoute(String path) {
        if (path.equals("/assistant") || path.equals("/assistant/")) {
            return true;
        }
        if (!path.startsWith("/assistant/")) {
            return false;
        }
        if (path.startsWith(GATEWAY_NAMESPACE) || path.startsWith(LOCAL_NAMESPACE)) {
            return false;
        }
        String lastSegment = path.substring(path.lastIndexOf('/') + 1);
        return !lastSegment.contains(".");
    }
}
