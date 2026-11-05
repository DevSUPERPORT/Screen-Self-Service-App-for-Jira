/**
 * Hosts every drawer (assign, copy, new, split, merge, locked, bulk, transition assignment) and the screen
 * editor according to the store's current overlay, and hides them when their target object disappeared
 * after a reload.
 *
 * @file        static/app/src/views/Overlays.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { AnimatePresence } from 'framer-motion';
import { useCallback } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Drawer } from '../ui';
import { AssignDrawer } from './Assign';
import { CopyDrawer, NewDrawer } from './Copy';
import { Editor } from './Editor';
import { LockedDrawer, MergeDrawer, SplitDrawer } from './Structure';
import { TransitionAssignDrawer } from './Transitions';
import { BulkDrawer } from './Bulk';

export function Overlays() {
  const t = useT();
  const o = useStore((s) => s.overlay);
  const model = useStore((s) => s.model);
  const close = useCallback(() => useStore.getState().open(null), []);
  const drawer = o && o.type !== 'editor' ? o : null;
  // Guard against objects that disappeared after a reload
  const valid = !o || !model || (
    (o.type === 'assign' || o.type === 'split' || o.type === 'merge') ? !!model.screenSchemes[o.schemeId]
      : (o.type === 'locked' || o.type === 'transitionAssign') ? !!model.screens[o.screenId] : true);
  const label = drawer ? ({ assign: t('changeAssignment'), copy: t('copyTitle'), new: t('newTitle'), split: t('splitOff'), merge: t('merge'), locked: t('whyLocked'), transitionAssign: t('trAssign'), bulk: t('bulkTitle') } as const)[drawer.type] : '';
  return (
    <>
      <Drawer open={!!drawer && valid} onClose={close} label={label} wide={drawer?.type === 'copy' || drawer?.type === 'bulk'}>
        {drawer?.type === 'assign' && <AssignDrawer key={drawer.schemeId} schemeId={drawer.schemeId} prefillOp={drawer.prefill?.op} onClose={close} />}
        {drawer?.type === 'copy' && <CopyDrawer issueTypeId={drawer.issueTypeId} op={drawer.op} templateId={drawer.templateId} onClose={close} />}
        {drawer?.type === 'new' && <NewDrawer issueTypeId={drawer.issueTypeId} op={drawer.op} onClose={close} />}
        {drawer?.type === 'split' && <SplitDrawer schemeId={drawer.schemeId} onClose={close} />}
        {drawer?.type === 'merge' && <MergeDrawer schemeId={drawer.schemeId} onClose={close} />}
        {drawer?.type === 'locked' && <LockedDrawer screenId={drawer.screenId} onClose={close} />}
        {drawer?.type === 'bulk' && <BulkDrawer init={drawer} onClose={close} />}
        {drawer?.type === 'transitionAssign' && <TransitionAssignDrawer screenId={drawer.screenId} onClose={close} />}
      </Drawer>
      <AnimatePresence>
        {o?.type === 'editor' && model?.screens[o.screenId] && <Editor key={o.screenId} screenId={o.screenId} origin={o.origin} onClose={close} />}
      </AnimatePresence>
    </>
  );
}
