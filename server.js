// CardVault Pro — Cloud Proxy (Railway)
// Handles: eBay Browse API (price lookup) + eBay Sell API (listing)
// Data sync is handled by Supabase directly — this proxy is eBay-only.
//
// Environment variables (set in Railway dashboard):
//   EBAY_SELLER_TOKENS   JSON string of { refresh_token, access_token, expires_at }
//                        Copy from ebay-seller-tokens.json after local OAuth setup
//   PORT                 Set automatically by Railway — do not override

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const PORT = process.env.PORT || 3939;

// ── Seller tokens ─────────────────────────────────────────────────────────────
// Loaded from env var on startup. Refreshed in memory as needed.
// Refresh tokens last 18 months — update EBAY_SELLER_TOKENS env var after re-auth.
let sellerTokens = null;
try {
  if (process.env.EBAY_SELLER_TOKENS) {
    sellerTokens = JSON.parse(process.env.EBAY_SELLER_TOKENS);
    console.log('  eBay seller tokens loaded from environment');
  } else {
    console.log('  EBAY_SELLER_TOKENS not set — seller features disabled until OAuth complete');
  }
} catch(e) {
  console.error('  Failed to parse EBAY_SELLER_TOKENS:', e.message);
}

// App-level token cache (Browse API)
const appTokenCache = {};

// Pending auth state (in-memory, no file)
let pendingAuth = null;

// ── SELL scopes ───────────────────────────────────────────────────────────────
const SELL_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
];

// ── Generic HTTPS fetch ───────────────────────────────────────────────────────
function fetchUrl(targetUrl, options, callback) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch(e) { return callback(new Error('Bad URL: ' + targetUrl)); }

  const reqOpts = {
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   options.method || 'GET',
    headers:  options.headers || {}
  };

  const req = https.request(reqOpts, res => {
    const enc = (res.headers['content-encoding'] || '').toLowerCase();
    let stream = res;
    if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8'), res.statusCode));
    stream.on('error', err => callback(err));
  });
  req.on('error', err => callback(err));
  req.setTimeout(20000, () => { req.destroy(); callback(new Error('Request timed out')); });
  if (options.body) req.write(options.body);
  req.end();
}

// ── App-level OAuth (Browse API) ─────────────────────────────────────────────
function getAppToken(appId, secret, callback) {
  const cached = appTokenCache[appId];
  if (cached && cached.expires > Date.now() + 60000) return callback(null, cached.token);

  const creds = Buffer.from(appId + ':' + secret).toString('base64');
  const body  = 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope';

  fetchUrl('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization':  'Basic ' + creds,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  }, (err, body2) => {
    if (err) return callback(err);
    try {
      const d = JSON.parse(body2);
      if (d.error) return callback(new Error(d.error_description || d.error));
      appTokenCache[appId] = { token: d.access_token, expires: Date.now() + (d.expires_in || 7200) * 1000 };
      callback(null, d.access_token);
    } catch(e) { callback(e); }
  });
}

// ── Seller-level OAuth ────────────────────────────────────────────────────────
function saveSellerTokens(data) {
  sellerTokens = data;
  // Log so it can be copied to Railway env var if needed
  console.log('  [ACTION REQUIRED] Update EBAY_SELLER_TOKENS env var in Railway with:');
  console.log(JSON.stringify(data));
}

function refreshSellerToken(appId, secret, callback) {
  if (!sellerTokens?.refresh_token) return callback(new Error('eBay seller account not connected'));

  const creds = Buffer.from(appId + ':' + secret).toString('base64');
  const body  = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(sellerTokens.refresh_token)
              + '&scope=' + encodeURIComponent(SELL_SCOPES.join(' '));

  fetchUrl('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization':  'Basic ' + creds,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  }, (err, respBody) => {
    if (err) return callback(err);
    try {
      const d = JSON.parse(respBody);
      if (d.error) return callback(new Error(d.error_description || d.error));
      sellerTokens = { ...sellerTokens, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 7200) * 1000 };
      callback(null, sellerTokens.access_token);
    } catch(e) { callback(e); }
  });
}

function getSellerToken(appId, secret, callback) {
  if (!sellerTokens) return callback(new Error('eBay seller account not connected — complete OAuth in Settings'));
  if (sellerTokens.expires_at && sellerTokens.expires_at > Date.now() + 60000) {
    return callback(null, sellerTokens.access_token);
  }
  refreshSellerToken(appId, secret, callback);
}

// ── Response helpers ──────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function jsonOk(res, data)          { setCors(res); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); }
function jsonError(res, status, msg){ setCors(res); res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:msg})); }

function collectBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 20e6) req.destroy(); });
  req.on('end', () => callback(body));
}

function xmlEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═════════════════════════════════════════════════════════════════════════════
http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let url;
  try { url = new URL('http://localhost' + req.url); } catch(e) { jsonError(res, 400, 'Bad URL'); return; }
  const p = url.pathname;

  // ── Health check ──────────────────────────────────────────────────────────
  if (p === '/' || p === '/health') {
    jsonOk(res, { ok: true, service: 'CardVault Pro Proxy', ebay: !!sellerTokens?.refresh_token });
    return;
  }

  // ── GET /ebay-price ── Browse API (active UK listings) ────────────────────
  if (p === '/ebay-price') {
    const q      = (url.searchParams.get('q')      || '').trim();
    const appId  = (url.searchParams.get('appid')  || '').trim();
    const secret = (url.searchParams.get('secret') || '').trim();
    if (!q || !appId || !secret) return jsonError(res, 400, 'Missing q, appid, or secret');

    getAppToken(appId, secret, (err, token) => {
      if (err) return jsonError(res, 502, 'Auth failed: ' + err.message);
      fetchUrl('https://api.ebay.com/buy/browse/v1/item_summary/search?q='
        + encodeURIComponent(q) + '&limit=20&fieldgroups=MATCHING_ITEMS', {
        headers: {
          'Authorization':           'Bearer ' + token,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
          'Accept':                  'application/json',
          'Accept-Encoding':         'gzip, deflate'
        }
      }, (err, body, status) => {
        if (err) return jsonError(res, 502, err.message);
        if (status === 401) return jsonError(res, 401, 'Token rejected — check App ID and Secret');
        if (status !== 200) return jsonError(res, status, 'eBay Browse returned HTTP ' + status);
        try {
          const data   = JSON.parse(body);
          const items  = (data.itemSummaries || []).filter(i => i.price && parseFloat(i.price.value) > 0);
          const prices = items.map(i => Math.round(parseFloat(i.price.value) * 100) / 100).sort((a,b) => a - b);
          const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
          jsonOk(res, { prices, median, count: prices.length, total: data.total || 0,
            items: items.slice(0,5).map(i => ({title:i.title, price:parseFloat(i.price.value), url:i.itemWebUrl})) });
        } catch(e) { jsonError(res, 502, 'Parse error'); }
      });
    });
    return;
  }

  // ── GET /ebay-auth-url ────────────────────────────────────────────────────
  if (p === '/ebay-auth-url') {
    const appId  = (url.searchParams.get('appid')  || '').trim();
    const ruName = (url.searchParams.get('runame') || '').trim();
    if (!appId || !ruName) return jsonError(res, 400, 'Missing appid or runame');
    const authUrl = 'https://auth.ebay.com/oauth2/authorize?client_id=' + encodeURIComponent(appId)
      + '&redirect_uri=' + encodeURIComponent(ruName)
      + '&response_type=code'
      + '&scope=' + encodeURIComponent(SELL_SCOPES.join(' '));
    jsonOk(res, { url: authUrl });
    return;
  }

  // ── POST /ebay-auth-init ── store pending auth credentials (in-memory) ────
  if (p === '/ebay-auth-init' && req.method === 'POST') {
    collectBody(req, body => {
      try { pendingAuth = JSON.parse(body); jsonOk(res, { ok: true }); }
      catch(e) { jsonError(res, 400, 'Bad JSON'); }
    });
    return;
  }

  // ── POST /ebay-exchange ── exchange auth code for tokens ──────────────────
  if (p === '/ebay-exchange' && req.method === 'POST') {
    collectBody(req, bodyStr => {
      let d;
      try { d = JSON.parse(bodyStr); } catch(e) { return jsonError(res, 400, 'Bad JSON'); }
      const { code, appId, secret, ruName } = d;
      if (!code || !appId || !secret || !ruName) return jsonError(res, 400, 'Missing fields');

      const b64  = Buffer.from(appId + ':' + secret).toString('base64');
      const body = 'grant_type=authorization_code&code=' + encodeURIComponent(code)
                 + '&redirect_uri=' + encodeURIComponent(ruName);

      fetchUrl('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Authorization':  'Basic ' + b64,
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      }, (err, respBody) => {
        if (err) return jsonError(res, 502, 'Token exchange failed: ' + err.message);
        try {
          const td = JSON.parse(respBody);
          if (td.error) return jsonError(res, 400, td.error_description || td.error);
          const tokens = {
            access_token:  td.access_token,
            refresh_token: td.refresh_token,
            expires_at:    Date.now() + (td.expires_in || 7200) * 1000
          };
          saveSellerTokens(tokens);
          console.log('  eBay seller account connected ✅');
          // Return tokens so user can copy to Railway env var
          jsonOk(res, { ok: true, tokens_for_env: JSON.stringify(tokens) });
        } catch(e) { jsonError(res, 502, 'Parse error'); }
      });
    });
    return;
  }

  // ── GET /ebay-auth-status ─────────────────────────────────────────────────
  if (p === '/ebay-auth-status') {
    jsonOk(res, { connected: !!sellerTokens?.refresh_token });
    return;
  }

  // ── GET /ebay-policies ────────────────────────────────────────────────────
  if (p === '/ebay-policies') {
    const appId  = (url.searchParams.get('appid')  || '').trim();
    const secret = (url.searchParams.get('secret') || '').trim();
    if (!appId || !secret) return jsonError(res, 400, 'Missing appid or secret');

    getSellerToken(appId, secret, (err, token) => {
      if (err) return jsonError(res, 401, err.message);
      const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' };
      let results = {}, pending = 3;
      function done(key, data) { results[key] = data; if (--pending === 0) jsonOk(res, results); }
      const policyTypes = [
        { endpoint: 'fulfillment_policy', responseKey: 'fulfillmentPolicies', storeKey: 'fulfillment_policy' },
        { endpoint: 'payment_policy',     responseKey: 'paymentPolicies',     storeKey: 'payment_policy'     },
        { endpoint: 'return_policy',      responseKey: 'returnPolicies',      storeKey: 'return_policy'      }
      ];
      policyTypes.forEach(({ endpoint, responseKey, storeKey }) => {
        fetchUrl('https://api.ebay.com/sell/account/v1/' + endpoint + '?marketplace_id=EBAY_GB', { headers }, (err, body, status) => {
          if (err || status !== 200) return done(storeKey, []);
          try { done(storeKey, JSON.parse(body)[responseKey] || []); } catch(e) { done(storeKey, []); }
        });
      });
    });
    return;
  }

  // ── POST /ebay-list ───────────────────────────────────────────────────────
  if (p === '/ebay-list' && req.method === 'POST') {
    collectBody(req, bodyStr => {
      let listing;
      try { listing = JSON.parse(bodyStr); } catch(e) { return jsonError(res, 400, 'Invalid JSON'); }

      const appId  = listing.appId  || '';
      const secret = listing.secret || '';
      if (!appId || !secret) return jsonError(res, 400, 'Missing appId / secret');

      getSellerToken(appId, secret, (err, token) => {
        if (err) return jsonError(res, 401, err.message);

        const isGraded = ['PSA','BGS','CGC','ACE','Arkezon'].includes(listing.condition);
        const condId   = isGraded ? 2750 : 4000;
        const ungradedCondIdMap = { NM:'400010', LP:'400015', MP:'400016', HP:'400017', Sealed:'400010' };
        const graderIdMap  = { PSA:'275010', BGS:'275013', CGC:'275015', ACE:'2750119', Arkezon:'2750123' };
        const gradeIdMap   = { '10':'275020','9.5':'275021','9':'275022','8.5':'275023','8':'275024','7.5':'275025','7':'275026','6.5':'275027','6':'275028','5.5':'275029','5':'2750210','4.5':'2750211','4':'2750212','3.5':'2750213','3':'2750214','2.5':'2750215','2':'2750216','1.5':'2750217','1':'2750218' };

        let condDescriptorsXml;
        if (isGraded) {
          const graderId = graderIdMap[listing.condition] || '2750123';
          const gradeId  = gradeIdMap[String(listing.grade)] || '';
          condDescriptorsXml = `<ConditionDescriptors>
      <ConditionDescriptor><Name>27501</Name><Value>${graderId}</Value></ConditionDescriptor>
      ${gradeId ? `<ConditionDescriptor><Name>27502</Name><Value>${gradeId}</Value></ConditionDescriptor>` : ''}
    </ConditionDescriptors>`;
        } else {
          condDescriptorsXml = `<ConditionDescriptors>
      <ConditionDescriptor><Name>40001</Name><Value>${ungradedCondIdMap[listing.condition]||'400010'}</Value></ConditionDescriptor>
    </ConditionDescriptors>`;
        }

        const condDesc     = { NM:'Near Mint', LP:'Lightly Played', MP:'Moderately Played', HP:'Heavily Played', Sealed:'Factory Sealed' }[listing.condition] || listing.condition;
        const condDescFull = listing.grade ? `${listing.condition} ${listing.grade} — professionally graded` : condDesc;
        const pictureXml   = (listing.imageUrls||[]).length
          ? `<PictureDetails>${listing.imageUrls.map(u=>`<PictureURL>${xmlEsc(u)}</PictureURL>`).join('')}</PictureDetails>` : '';
        const location     = xmlEsc(listing.itemLocation || 'United Kingdom');

        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <Title>${xmlEsc(listing.title)}</Title>
    <Description><![CDATA[${listing.description.replace(/\n/g,'<br>')}]]></Description>
    <PrimaryCategory><CategoryID>183454</CategoryID></PrimaryCategory>
    <StartPrice currencyID="GBP">${listing.price.toFixed(2)}</StartPrice>
    <ConditionID>${condId}</ConditionID>
    <ConditionDescription>${xmlEsc(condDescFull)}</ConditionDescription>
    ${condDescriptorsXml}
    <Country>GB</Country>
    <Currency>GBP</Currency>
    <DispatchTimeMax>2</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${location}</Location>
    <Quantity>${listing.quantity || 1}</Quantity>
    <Site>UK</Site>
    ${pictureXml}
    <ItemSpecifics>
      <NameValueList><Name>Game</Name><Value>Pokémon</Value></NameValueList>
      <NameValueList><Name>Graded</Name><Value>${isGraded?'Yes':'No'}</Value></NameValueList>
      <NameValueList><Name>Card Name</Name><Value>${xmlEsc(listing.cardName||'')}</Value></NameValueList>
      <NameValueList><Name>Set</Name><Value>${xmlEsc(listing.setCode||'')}</Value></NameValueList>
      <NameValueList><Name>Card Number</Name><Value>${xmlEsc(listing.cardNumber||'')}</Value></NameValueList>
    </ItemSpecifics>
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>${xmlEsc(listing.fulfillmentPolicyId)}</ShippingProfileID></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>${xmlEsc(listing.returnPolicyId)}</ReturnProfileID></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>${xmlEsc(listing.paymentPolicyId)}</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles>
  </Item>
</AddFixedPriceItemRequest>`;

        fetchUrl('https://api.ebay.com/ws/api.dll', {
          method: 'POST',
          headers: {
            'X-EBAY-API-IAF-TOKEN':          token,
            'X-EBAY-API-SITEID':             '3',
            'X-EBAY-API-CALL-NAME':          'AddFixedPriceItem',
            'X-EBAY-API-APP-NAME':           appId,
            'X-EBAY-API-COMPATIBILITY-LEVEL':'1155',
            'X-EBAY-API-REQUEST-ENCODING':   'XML',
            'Content-Type':                  'text/xml;charset=UTF-8',
            'Content-Length':                Buffer.byteLength(xmlBody)
          },
          body: xmlBody
        }, (err, respBody, status) => {
          if (err) return jsonError(res, 502, 'Trading API error: ' + err.message);
          const itemIdMatch  = respBody.match(/<(?:\w+:)?ItemID>\s*(\d+)\s*<\/(?:\w+:)?ItemID>/);
          const ackMatch     = respBody.match(/<(?:\w+:)?Ack>\s*([^<]+?)\s*<\/(?:\w+:)?Ack>/);
          const errorBlocks  = [...respBody.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)].map(m => {
            const b = m[1];
            return { short: (b.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)||[])[1]||'?' };
          });
          const itemId = itemIdMatch ? itemIdMatch[1] : null;
          if (itemId) {
            jsonOk(res, { listingId: itemId, listingUrl: 'https://www.ebay.co.uk/itm/' + itemId });
          } else {
            jsonError(res, 400, 'Listing failed: ' + (errorBlocks[0]?.short || 'HTTP ' + status));
          }
        });
      });
    });
    return;
  }

  jsonError(res, 404, 'Unknown endpoint: ' + p);

}).listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  CardVault Pro — Cloud Proxy');
  console.log('  Listening on port ' + PORT);
  console.log('  eBay seller: ' + (sellerTokens ? 'connected ✅' : 'not connected — complete OAuth in app Settings'));
  console.log('');
});
