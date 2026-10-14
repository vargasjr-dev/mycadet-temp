import { useEffect, useState, type ReactNode } from "react";

import { CopyButton } from "@/components/copy-button";
import { fetchMyDevice, type MyDeviceRecord } from "@/lib/devices/my-device";
import { useTranslation } from "@/i18n";

/**
 * "This device" — the paired-device row the assistant's gateway keeps for
 * this browser, shown so the user can match it against the host-side
 * `cadet devices` list. The gateway stores only the hashed device id, so
 * that hash is the identity both sides share.
 *
 * Renders nothing until a paired gateway session answers: cloud-hosted
 * assistants have no gateway device rows, and a not-yet-paired browser has
 * nothing to show either.
 */
export function ThisDeviceSection(): ReactNode {
  const { t } = useTranslation("settings");
  const [device, setDevice] = useState<MyDeviceRecord | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchMyDevice(controller.signal)
      .then((record) => {
        setDevice(record);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => controller.abort();
  }, []);

  if (!loaded || !device) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        {t("thisDeviceSection.title")}
      </h3>
      <p className="text-body-medium-default text-[var(--content-tertiary)]">
        {t("thisDeviceSection.description")}
      </p>
      <div className="mt-1 flex items-center gap-1">
        <code className="text-body-small-default break-all text-[var(--content-secondary)]">
          {device.hashedDeviceId}
        </code>
        <CopyButton
          text={device.hashedDeviceId}
          ariaLabel={t("thisDeviceSection.copyHint")}
        />
      </div>
    </section>
  );
}
