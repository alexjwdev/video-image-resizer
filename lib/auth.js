'use strict';

const crypto = require('crypto');
const express = require('express');

const SCOPES = ['user.read'];

// Auth is entirely optional: unset MS_CLIENT_ID and the app runs with no
// login at all (the original internal-LAN-tool default). Set all five vars
// to require Microsoft sign-in before serving anything else.
function isAuthEnabled() {
  return !!(
    process.env.MS_CLIENT_ID &&
    process.env.MS_CLIENT_SECRET &&
    process.env.MS_TENANT_ID &&
    process.env.MS_REDIRECT_URI &&
    process.env.SESSION_SECRET
  );
}

function buildMsalClient() {
  const { ConfidentialClientApplication } = require('@azure/msal-node');
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.MS_CLIENT_ID,
      clientSecret: process.env.MS_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
    },
  });
}

// Only allow same-origin relative paths as a post-login redirect target -
// blocks the open-redirect trick of passing ?next=https://evil.example.
function sanitizeNextPath(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function createAuthRouter() {
  const router = express.Router();
  const msalClient = buildMsalClient();
  const redirectUri = process.env.MS_REDIRECT_URI;

  router.get('/login', async (req, res, next) => {
    try {
      const state = crypto.randomUUID();
      req.session.oauthState = state;
      req.session.postLoginRedirect = sanitizeNextPath(req.query.next);
      const authUrl = await msalClient.getAuthCodeUrl({ scopes: SCOPES, redirectUri, state });
      res.redirect(authUrl);
    } catch (err) { next(err); }
  });

  router.get('/callback', async (req, res) => {
    // CSRF guard: the state we handed Microsoft at /login must round-trip
    // unchanged. Check this before touching the auth code at all.
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(401).send('Sign-in session expired or invalid - close this tab and try again.');
    }
    const dest = req.session.postLoginRedirect || '/';
    delete req.session.oauthState;
    delete req.session.postLoginRedirect;

    try {
      const result = await msalClient.acquireTokenByCode({ code: req.query.code, scopes: SCOPES, redirectUri });
      req.session.account = { name: result.account.name, username: result.account.username };
      res.redirect(dest);
    } catch (err) {
      console.error('[auth] token exchange failed:', err);  // full error server-side only
      res.status(401).send('Sign-in failed - close this tab and try again.');
    }
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  return router;
}

function requireAuth(req, res, next) {
  if (!isAuthEnabled()) return next();
  if (req.path.startsWith('/auth/')) return next();
  if (req.session && req.session.account) return next();
  res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
}

module.exports = { isAuthEnabled, createAuthRouter, requireAuth };
