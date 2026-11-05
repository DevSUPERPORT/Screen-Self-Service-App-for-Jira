/**
 * React error boundary around the whole Custom UI. When rendering crashes it logs the error and shows a
 * translated error page with a reload button, so users never see a blank page or a raw runtime error.
 *
 * @file        static/app/src/Boundary.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { Component, type ReactNode } from 'react';
import { translate, useLang } from './i18n';

/** Last line of defence: never leave the user with a blank page — and never show raw runtime errors. */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    const lang = useLang.getState().lang;
    return (
      <div className="empty" style={{ minHeight: '80vh', justifyContent: 'center' }}>
        <h1 className="h1">{translate(lang, 'errorTitle')}</h1>
        <p className="muted" style={{ maxWidth: 520 }}>{translate(lang, 'crashBody')}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>{translate(lang, 'reloadPage')}</button>
      </div>
    );
  }
}
