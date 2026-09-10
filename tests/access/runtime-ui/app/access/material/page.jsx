import AuthenticatedMaterial from '../../../../../../src/components/access/AuthenticatedMaterial';
export default function Page() {
  return <AuthenticatedMaterial transport={{profile:'session/1',uiOrigin:'https://ui.inc02.test:8443',terminalOrigin:'https://api.inc02.test:9443'}} />;
}
