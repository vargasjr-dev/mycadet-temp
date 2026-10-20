package ai.mycadet.android;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads the Cadet CLI's lockfile off disk and hands the raw JSON text across
 * the bridge. The baked web bundle's local-mode seam
 * ({@code clients/web/src/runtime/local-mode-host.ts}) parses it and strips
 * the sensitive fields web-side — the same {@code stripSensitiveFields} the
 * dev-server host runs — so this plugin deliberately ships the file's bytes
 * rather than parsed, redacted data: one sanitizer, identical wire shape on
 * every host.
 *
 * Candidate paths mirror the CLI's own resolution ({@code CADET_LOCKFILE_DIR}
 * override, then the {@code cadet}/{@code cadet-local}/{@code cadet-dev} XDG
 * config dirs). A phone or emulator has no Cadet CLI install, so the read
 * rejects there and the web layer falls back to its persisted mirror /
 * empty-lockfile state — the same honest degradation a missed dev server
 * produces — while a rooted QA emulator with a pushed lockfile reads it like
 * any host.
 */
@CapacitorPlugin(name = "LockfilePlugin")
public class LockfilePlugin extends Plugin {
    private static final String LOCKFILE_DIR_OVERRIDE = "CADET_LOCKFILE_DIR";
    private static final String[] ENVIRONMENT_SUFFIXES = {"", "-local", "-dev"};

    @PluginMethod
    public void readLockfile(PluginCall call) {
        String text = readFirstLockfile();
        if (text == null) {
            call.reject("No Cadet lockfile was found on this machine.");
            return;
        }
        JSObject result = new JSObject();
        result.put("lockfile", text);
        call.resolve(result);
    }

    private static String readFirstLockfile() {
        for (String candidate : candidateLockfilePaths()) {
            File file = new File(candidate);
            if (!file.isFile()) {
                continue;
            }
            try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
                StringBuilder builder = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    builder.append(line).append('\n');
                }
                return builder.toString();
            } catch (IOException exception) {
                // Try the next candidate.
            }
        }
        return null;
    }

    private static List<String> candidateLockfilePaths() {
        List<String> candidates = new ArrayList<>();
        String override = System.getenv(LOCKFILE_DIR_OVERRIDE);
        if (override != null && !override.isEmpty()) {
            candidates.add(override + "/lockfile.json");
        }
        String home = System.getProperty("user.home");
        if (home == null || home.isEmpty()) {
            return candidates;
        }
        for (String suffix : ENVIRONMENT_SUFFIXES) {
            candidates.add(home + "/.config/cadet" + suffix + "/lockfile.json");
        }
        return candidates;
    }
}
