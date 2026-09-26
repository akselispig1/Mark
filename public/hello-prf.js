// Windows Hello, including the PRF extension that lets it hold the vault key.
// PRF asks the security chip for a secret that only exists after your face, fingerprint or PIN —
// and only for this site. Shared by the orb and the vault window.
(() => {
  const b64u = {
    toBuf: (v) => Uint8Array.from(atob(String(v).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    from: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  };

  /** Make a new Hello key, asking for PRF so it can open the vault later. */
  async function helloRegister(o) {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64u.toBuf(o.challenge),
        rp: o.rp,
        user: { id: b64u.toBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams,
        timeout: o.timeout,
        attestation: o.attestation,
        authenticatorSelection: o.authenticatorSelection,
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ id: b64u.toBuf(c.id), type: 'public-key', transports: c.transports })),
        extensions: { prf: {} },
      },
    });
    return {
      id: cred.id, rawId: b64u.from(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u.from(cred.response.clientDataJSON),
        attestationObject: b64u.from(cred.response.attestationObject),
        transports: cred.response.getTransports?.() || [],
      },
    };
  }

  /** Confirm it's you, and hand back the secret that unwraps the vault. */
  async function helloAssert(o) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64u.toBuf(o.challenge),
        rpId: o.rpId,
        timeout: o.timeout,
        userVerification: 'required',
        allowCredentials: (o.allowCredentials || []).map((c) => ({ id: b64u.toBuf(c.id), type: 'public-key', transports: c.transports })),
        extensions: { prf: { eval: { first: b64u.toBuf(o.salt) } } },
      },
    });
    const prf = cred.getClientExtensionResults()?.prf?.results?.first;
    if (!prf) throw new Error("This device's Windows Hello can't hold a key for the vault, so the master password is still needed here.");
    return {
      prf: b64u.from(prf),
      response: {
        id: cred.id, rawId: b64u.from(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment,
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u.from(cred.response.clientDataJSON),
          authenticatorData: b64u.from(cred.response.authenticatorData),
          signature: b64u.from(cred.response.signature),
          userHandle: cred.response.userHandle ? b64u.from(cred.response.userHandle) : undefined,
        },
      },
    };
  }

  window.__prf = { b64u, helloRegister, helloAssert };
})();
