import { SafeExternalLink } from '@/components/ui';
import type { ReportEvidenceItem } from '@/lib/live-bus';
import { evidenceLabel, isExternalLinkEvidence, isImageEvidence, isVideoEvidence } from './helpers';

export function ReportEvidenceBlock({ evidence }: { evidence: ReportEvidenceItem[] }) {
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h3 className="text-[13px] font-semibold text-ink">Доказательства</h3>
      <div className="flex flex-wrap gap-3">
        {evidence.map((item) => (
          <div key={item.id} className="max-w-[220px] space-y-1">
            {isImageEvidence(item) ? (
              <img
                src={`/api/v1/media/${item.id}/stream`}
                alt={evidenceLabel(item)}
                className="max-h-40 rounded-ctl border border-line object-cover"
              />
            ) : isVideoEvidence(item) ? (
              // biome-ignore lint/a11y/useMediaCaption: user-submitted evidence has no captions
              <video
                controls
                src={`/api/v1/media/${item.id}/stream`}
                className="max-h-40 rounded-ctl border border-line"
              />
            ) : isExternalLinkEvidence(item) && item.external_url ? (
              <SafeExternalLink
                href={item.external_url}
                className="block truncate text-xs text-accent no-underline hover:brightness-110"
              >
                {evidenceLabel(item)}
              </SafeExternalLink>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
