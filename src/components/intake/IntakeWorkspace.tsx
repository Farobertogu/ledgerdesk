'use client';

import {useEffect, useState, useSyncExternalStore} from 'react';
import type {SessionTransport} from '../../contracts/access_transport';
import {IntakeController} from './controller';
import {IntakeView, WorkspaceView, PreparationEditorView, InspectorView, ConfirmationView} from './views';

export default function IntakeWorkspace({transport}: {transport: SessionTransport}) {
  const [controller] = useState(() => new IntakeController(transport, {
    getItem: key => window.sessionStorage.getItem(key),
    setItem: (key, value) => window.sessionStorage.setItem(key, value),
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    if (window.location.origin !== transport.uiOrigin) {controller.suspend(); return;}
    void controller.start();
    const leave = () => controller.suspend();
    window.addEventListener('pagehide', leave);
    return () => {window.removeEventListener('pagehide', leave); controller.suspend();};
  }, [controller, transport.uiOrigin]);
  return <WorkspaceView phase={state.phase} context={state.context} items={state.items} selectedKey={state.selectedKey}
    notices={state.notices} intakeOffered={state.intakeOffered} onSelect={controller.select}
    onOpenIntake={controller.openIntake} onRefresh={() => void controller.start()}
    body={preferences => state.page === 'confirmation' && state.confirmation && state.items.some(item => item.key === state.selectedKey) ?
      <ConfirmationView preferences={preferences} item={state.items.find(item => item.key === state.selectedKey)!}
        {...state.confirmation} notices={[]} busy={state.busy} onConfirm={() => void controller.confirm()}
        onReconcile={() => state.selectedKey && void controller.action(state.selectedKey, 'reconcile')} onBack={controller.openIntake}/> :
      state.page === 'inspector' && state.inspector && state.items.some(item => item.key === state.selectedKey) ?
      <InspectorView preferences={preferences} item={state.items.find(item => item.key === state.selectedKey)!}
        {...state.inspector} notices={[]} busy={state.busy}
        onDownloadOriginal={() => void controller.downloadOriginal()} onDownloadResource={reference => void controller.downloadResource(reference)}
        onProposalDraft={controller.setProposalDraft} onProposalUnit={controller.setProposalUnit} onPropose={() => void controller.propose()} onBack={controller.openIntake}/> :
      state.page === 'editor' && state.editor && state.items.some(item => item.key === state.selectedKey) ?
      <PreparationEditorView preferences={preferences} item={{...state.items.find(item => item.key === state.selectedKey)!,
        actions: state.editor.discardOffered ? ['discard'] : []}}
        antecedents={[state.editor.antecedent as {id: string; revision: number; sha256: string}]} elements={state.editor.elements}
        observations={state.items.find(item => item.key === state.selectedKey)!.observations} draft={state.editor.draft}
        busy={state.busy} saveOffered={state.editor.saveOffered} notices={[]} onEdit={controller.editPreparation}
        onSave={() => void controller.savePreparation()} onBack={controller.openIntake} onDiscardLocal={controller.discardPreparation}/> :
      <IntakeView preferences={preferences} context={state.context} profiles={state.profiles}
      items={state.page === 'detail' ? state.items.filter(item => item.key === state.selectedKey) : state.items}
      textDraft={state.textDraft} busy={state.busy} intakeOffered={state.intakeOffered} notices={[]}
      onFiles={files => void controller.addFiles(files)} onProfile={controller.setProfile} onTextDraft={controller.setTextDraft}
      onCaptureText={controller.captureText} onAction={(key, action) => void controller.action(key, action)} onBack={controller.openIntake}/>}/>;
}
