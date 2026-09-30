import { isSafeHttpUrl } from '@squad/shared-types';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export interface SafeExternalLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> {
  href: string;
  children?: ReactNode;
}

/**
 * `<a>` for an operator-supplied URL (evidence links, external-ban Discord
 * links, publication links) that only ever came through `z.string().url()`
 * on the API before scheme allowlisting existed there too (#445).
 *
 * Renders the link only when `href` is an absolute `http:`/`https:` URL;
 * otherwise renders the raw value as plain text, so a `javascript:`/`data:`
 * URL written before that validation existed can never reach a real
 * navigable `href` — React's own scheme blocking stops being the only line
 * of defense.
 */
export function SafeExternalLink({ href, children, ...rest }: SafeExternalLinkProps) {
  if (!isSafeHttpUrl(href)) return <span {...rest}>{children ?? href}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children ?? href}
    </a>
  );
}
