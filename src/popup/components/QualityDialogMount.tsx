import { QualityDialog } from "../../ui/components/QualityDialog.js";
import { onQualityDialogBack, onQualityDialogCancel, onQualityFormatSelected, qualityDialog } from "../state/app.js";

/**
 * The popup's quality chooser: the same `ui/components/QualityDialog.tsx` the
 * in-page overlay renders (spec §5 Phase 4/6). This replaces the popup's private
 * imperative `shared/quality_dialog.js` and its hand-written shell in `popup.html` —
 * two implementations of one dialog, now one component with two mount points.
 *
 * The dialog is the only thing here. The promise it resolves, and the request serial
 * that invalidates an abandoned `getVideoFormats`, live in `popup_actions.js` because
 * they belong to the download flow rather than to the view.
 */
export function QualityDialogMount() {
  const dialog = qualityDialog.value;

  return (
    <QualityDialog
      open={dialog.open}
      view={dialog.view}
      title={dialog.title}
      hasBack={dialog.hasBack}
      statusText={dialog.statusText}
      nativeError={dialog.nativeError}
      videos={[]}
      formats={dialog.formats as never[]}
      onBack={onQualityDialogBack}
      onCancel={onQualityDialogCancel}
      onSelectVideo={() => {}}
      onSelectFormat={onQualityFormatSelected}
    />
  );
}
