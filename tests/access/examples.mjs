const csrf = 'A'.repeat(43);
const grant = { permission_id: 'ask', exercise_or_grant: 'exercise', scope_ref: 'scope:one', support_ref: 'support:one' };
const completed = { operation_id: 'operation:one', status: 'completed', revision: 1 };
const accepted = { status: 'accepted' };
const session = { authenticated: true, session_revision: 1, csrf_token: csrf };
const proof = { challenge_id: 'challenge:one', code: csrf, password: 'Synthetic example only' };
const invitation = { email: 'Recipient@Example.test', family: 'application', grants: [grant], expires_at: 1800000000000 };

// Independent, concrete fixtures. They are not generated from the schemas.
export const examples = {
  activation_challenge: [{ email: 'Master@Example.test' }, accepted],
  activate_master: [proof, completed],
  login: [{ email: 'Master@Example.test', password: 'Synthetic example only' }, session],
  logout: [{}, completed],
  recovery_challenge: [{ email: 'Master@Example.test' }, accepted],
  recover_credential: [proof, completed],
  issue_invitation: [invitation, { invitation_id: 'invitation:one', revision: 1, status: 'pending_acceptance' }],
  invitation_view: [{}, { invitation_id: 'invitation:one', revision: 1, ...invitation }],
  invitation_challenge: [{}, accepted],
  verify_invitation_email: [{ code: csrf }, { proof_id: 'proof:one', expires_at: 1800000000000 }],
  accept_invitation: [{ expected_revision: 2, proof_id: 'proof:one' }, completed],
  initial_credential: [{ password: 'Synthetic initial verifier only' }, completed],
  withdraw_invitation: [{ expected_revision: 2, reason: 'Terms withdrawn' }, completed],
  withdraw_grant: [{ expected_revision: 2, reason: 'Scope no longer applicable' }, completed],
  current_session: [{}, session],
  capabilities: [{}, { revision: 1, capabilities: [{ capability_id: 'reading', implemented: true, enabled: true, authorized: 'no', executable: 'no' }] }],
  people: [{ cursor: '' }, { people: [{ account_id: 'account:one', display_name: 'Synthetic recipient' }], revision: 1, next_cursor: '' }],
  operation_result: [{}, { operation_id: 'operation:one', status: 'accepted' }],
};
