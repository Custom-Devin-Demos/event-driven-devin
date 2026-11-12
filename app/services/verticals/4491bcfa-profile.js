/**
 * Account read model for the 4491bcfa EA Account portal.
 *
 * Each getter resolves an account from the directory and returns the view the
 * self-service portal renders. Serializers are kept here so every account read
 * path shares one representation.
 */

const { getAccount } = require('./4491bcfa-accounts');

class AccountError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'AccountError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireSession(session) {
  if (!session || !session.sessionId) {
    throw new AccountError('Sign in to view this account', 401, 'NOT_AUTHENTICATED');
  }
}

function loadAccount(accountId) {
  const account = getAccount(accountId);
  if (!account) {
    throw new AccountError(`Account ${accountId} not found`, 404, 'ACCOUNT_NOT_FOUND');
  }
  return account;
}

function assertOwnership(session, accountId) {
  if (session.ownerAccount !== accountId) {
    throw new AccountError('You can only view your own account', 403, 'FORBIDDEN');
  }
}

function serializeProfile(account) {
  return {
    accountId: account.accountId,
    eaId: account.eaId,
    displayName: account.displayName,
    email: account.email,
    country: account.country,
    location: account.location,
    memberSince: account.memberSince,
    avatarColor: account.avatarColor,
    linkedPlatforms: account.linkedPlatforms,
    lastLogin: account.lastLogin,
    security: {
      twoFactorEnabled: account.security.twoFactorEnabled,
      loginVerificationEmail: account.security.loginVerificationEmail,
    },
  };
}

function serializeLinkedPlatforms(account) {
  return { accountId: account.accountId, linkedPlatforms: account.linkedPlatforms };
}

function serializeSecurity(account) {
  return {
    accountId: account.accountId,
    email: account.email,
    security: account.security,
    lastLogin: account.lastLogin,
  };
}

function getAccountProfile(accountId, session) {
  requireSession(session);
  assertOwnership(session, accountId);
  const account = loadAccount(accountId);
  return serializeProfile(account);
}

function getLinkedPlatforms(accountId, session) {
  requireSession(session);
  assertOwnership(session, accountId);
  const account = loadAccount(accountId);
  return serializeLinkedPlatforms(account);
}

function getSecuritySettings(accountId, session) {
  requireSession(session);
  assertOwnership(session, accountId);
  const account = loadAccount(accountId);
  return serializeSecurity(account);
}

module.exports = {
  AccountError,
  serializeProfile,
  serializeLinkedPlatforms,
  serializeSecurity,
  getAccountProfile,
  getLinkedPlatforms,
  getSecuritySettings,
};
