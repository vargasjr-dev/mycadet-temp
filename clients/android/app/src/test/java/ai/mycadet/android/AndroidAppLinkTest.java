package ai.mycadet.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.net.URI;
import org.junit.Test;

public class AndroidAppLinkTest {
    private static final String HOST = "dev.mycadet.ai";

    @Test
    public void acceptsTheFlavorHostAndPreservesTheFullUrl() {
        String raw =
            "https://dev.mycadet.ai/assistant/conversations/conv-xyz?next=%2Fassistant%2Fplans#reply%2Fmessage-123";

        URI appLink = AndroidAppLink.parse(raw, HOST);

        assertEquals(raw, appLink.toASCIIString());
        assertEquals(
            "https://dev.mycadet.ai/assistant/pair?deviceCode=device-123#approval",
            AndroidAppLink.parse(
                "https://dev.mycadet.ai/assistant/pair?deviceCode=device-123#approval",
                HOST
            ).toASCIIString()
        );
        assertEquals(
            "https://dev.mycadet.ai/account/oauth/complete?requestId=request-123",
            AndroidAppLink.parse(
                "https://dev.mycadet.ai/account/oauth/complete?requestId=request-123",
                HOST
            ).toASCIIString()
        );
        assertEquals(
            "https://dev.mycadet.ai/assistant/settings/billing/upgrade/success",
            AndroidAppLink.parse(
                "https://dev.mycadet.ai/assistant/settings/billing/upgrade/success",
                HOST
            ).toASCIIString()
        );
    }

    @Test
    public void rejectsOtherFlavorsAndNonHttpsUrls() {
        assertNull(
            AndroidAppLink.parse("https://mycadet.ai/assistant/conversations/conv-xyz", HOST)
        );
        assertNull(AndroidAppLink.parse("http://dev.mycadet.ai/assistant", HOST));
        assertNull(
            AndroidAppLink.parse("https://dev.mycadet.ai:444/assistant", HOST)
        );
    }

    @Test
    public void rejectsUnownedAndEncodedPaths() {
        assertNull(AndroidAppLink.parse("https://dev.mycadet.ai/assistant/logs", HOST));
        assertNull(
            AndroidAppLink.parse("https://dev.mycadet.ai/assistant/pairing", HOST)
        );
        assertNull(
            AndroidAppLink.parse(
                "https://dev.mycadet.ai/assistant/conversations/../logs",
                HOST
            )
        );
        assertNull(
            AndroidAppLink.parse(
                "https://dev.mycadet.ai/assistant/conversations/%2e%2e/logs",
                HOST
            )
        );
    }

    /**
     * The conversation shortcut's tap target is built here and parsed here, so
     * a shortcut tap always lands on the conversation route.
     */
    @Test
    public void buildsAConversationLinkItParsesBack() {
        String url = AndroidAppLink.conversationUrl(HOST, "conv-xyz");

        assertEquals("https://dev.mycadet.ai/assistant/conversations/conv-xyz", url);
        assertEquals(url, AndroidAppLink.parse(url, HOST).toASCIIString());
    }

    @Test
    public void buildsNoConversationLinkForAnIdThatCannotSitInAPathSegment() {
        assertNull(AndroidAppLink.conversationUrl(HOST, null));
        assertNull(AndroidAppLink.conversationUrl(HOST, ""));
        assertNull("traversal", AndroidAppLink.conversationUrl(HOST, "../pair"));
        assertNull("escaped", AndroidAppLink.conversationUrl(HOST, "a%2Fb"));
        assertNull("separator", AndroidAppLink.conversationUrl(HOST, "a/b"));
        assertNull("query", AndroidAppLink.conversationUrl(HOST, "a?b=c"));
    }
}
