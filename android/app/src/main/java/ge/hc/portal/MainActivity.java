package ge.hc.portal;

import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import com.google.android.gms.auth.api.phone.SmsRetriever;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Status;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The app is the website in a WebView. window.HCNative gives the page what a WebView lacks:
 *  - saveFile(name, mime, base64): writes an export to Downloads and opens it ("" = saved, else the error)
 *  - listenForSmsCode(): waits for the login SMS (SMS User Consent: the user taps "Allow" once, no SMS
 *    permission) and hands its 6-digit code to the page as a `hc-otp` window event.
 *  - print(jobName): Android's print dialog for the page (a WebView ignores window.print()).
 */
public class MainActivity extends BridgeActivity {
    private static final Pattern CODE = Pattern.compile("(?<!\\d)(\\d{6})(?!\\d)");
    private ActivityResultLauncher<Intent> smsConsent;
    private BroadcastReceiver smsReceiver;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        smsConsent = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (result.getResultCode() != RESULT_OK || result.getData() == null) return;
            String message = result.getData().getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE);
            if (message == null) return;
            Matcher m = CODE.matcher(message);
            if (m.find()) dispatchCode(m.group(1));
        });
        getBridge().getWebView().addJavascriptInterface(new Bridge(), "HCNative");
    }

    @Override
    public void onDestroy() {
        stopSmsListener();
        super.onDestroy();
    }

    private void dispatchCode(String code) {
        runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('hc-otp',{detail:'" + code + "'}))", null));
    }

    private void stopSmsListener() {
        if (smsReceiver != null) {
            try {
                unregisterReceiver(smsReceiver);
            } catch (IllegalArgumentException ignored) {
            }
            smsReceiver = null;
        }
    }

    private void startSmsListener() {
        stopSmsListener();
        smsReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!SmsRetriever.SMS_RETRIEVED_ACTION.equals(intent.getAction()) || intent.getExtras() == null) return;
                Status status = (Status) intent.getExtras().get(SmsRetriever.EXTRA_STATUS);
                if (status == null || status.getStatusCode() != CommonStatusCodes.SUCCESS) return;
                Intent consent = intent.getExtras().getParcelable(SmsRetriever.EXTRA_CONSENT_INTENT);
                if (consent == null) return;
                // Only Google Play services' own consent screen, without URI grants (Android's intent-redirection rule).
                if (consent.resolveActivity(getPackageManager()) == null
                    || !"com.google.android.gms".equals(consent.resolveActivity(getPackageManager()).getPackageName())) return;
                consent.setFlags(consent.getFlags() & ~(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION));
                try {
                    smsConsent.launch(consent);
                } catch (ActivityNotFoundException ignored) {
                }
                stopSmsListener();
            }
        };
        ContextCompat.registerReceiver(this, smsReceiver, new IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
            SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED);
        SmsRetriever.getClient(this).startSmsUserConsent(null);
    }

    private String save(String name, String mime, byte[] bytes) throws Exception {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        Uri uri;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver cr = getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("Downloads unavailable");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new Exception("Downloads unavailable");
                out.write(bytes);
            }
        } else {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) throw new Exception("Storage unavailable");
            File f = new File(dir, safe);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
            }
            uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f);
        }
        final Uri opened = uri;
        runOnUiThread(() -> {
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(opened, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                startActivity(view);
            } catch (ActivityNotFoundException e) {
                Toast.makeText(this, safe + " — შენახულია Downloads-ში", Toast.LENGTH_LONG).show();
            }
        });
        return "";
    }

    private class Bridge {
        @JavascriptInterface
        public String saveFile(String name, String mime, String base64) {
            try {
                return save(name, mime, Base64.decode(base64, Base64.DEFAULT));
            } catch (Exception e) {
                return "ფაილი ვერ შეინახა: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void print(String jobName) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                if (pm == null) return;
                String name = jobName == null || jobName.isEmpty() ? "HC Portal" : jobName;
                pm.print(name, getBridge().getWebView().createPrintDocumentAdapter(name),
                    new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
            });
        }

        @JavascriptInterface
        public void listenForSmsCode() {
            runOnUiThread(() -> {
                try {
                    startSmsListener();
                } catch (Exception ignored) {
                    // No Google Play services: the code is typed (or offered by the keyboard).
                }
            });
        }
    }
}
