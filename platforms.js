const PLATFORMS = {
  winner7: {
    name: 'Winner7',
    loginUrl: 'https://user-backend-api.playexchwin.com/api/member/memberLogin',
    marketsUrl: 'https://netexposure.playexchwin.com/api/Book/getBooksForBackend',
    origin: 'https://backend.winner7.co',

    loginBody(username, password) {
      return { username, password, siteOrigin: 'playexch.co' };
    },

    extractToken(json) {
      const memberData = json.data?.memberData;
      const accessToken = memberData?.accessToken?.[0];
      const newToken = json.data?.newToken;
      const token = accessToken || newToken;
      if (!token) throw new Error(json.message || json.error || 'Login failed - no token returned');
      const userId = memberData?._id;
      let exp;
      if (token.includes('.')) {
        const payload = token.split('.')[1];
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
        exp = decoded.exp;
      } else {
        exp = Math.floor(Date.now() / 1000) + 86400;
      }
      return { token, userId, exp };
    },

    authHeader(token) {
      return { 'x-key-id': `Bearer ${token}` };
    },

    marketsBody(client, token) {
      return {
        _accessToken: token,
        filter: {
          user: client.user_id,
          eventname: 'All',
          level: 'Master',
          status: { $ne: 'Done' },
          eventType: client.sports || 'All',
          bookmakerSessionFlag: 'all',
          _accessToken: token,
        },
        selectedType: client.book_view || 'Total Book',
        page: 1,
      };
    },

    parseMarkets(json) {
      const events = json.data || [];
      const raw = events.flatMap(event => event.data || []);
      return raw.map(item => {
        const teams = (item.eventName || '').split(' v ');
        const horses = item.horse || item.runners || item.selections || [];
        return {
          id: item._id || item.marketId || `${item.eventName}-${item.marketName}`,
          eventName: item.eventName || 'Unknown',
          marketName: item.marketName || 'Unknown',
          netExposure: Math.abs(item.netExposure ?? item.maxLoss ?? item.exposure ?? 0),
          runners: horses.map((r, i) => ({
            name: r.name || r.runnerName || r.selectionName || teams[i] || `Runner ${i + 1}`,
            exposure: r.amount ?? r.exposure ?? r.winLoss ?? r.pl ?? 0,
          })),
        };
      });
    },
  },

  leoexch: {
    name: 'LeoExch',
    loginUrl: 'https://adminapi.winzone.uk/user/adminlogin',
    marketsUrl: 'https://adminapi.winzone.uk/sportsbook/getAllBooksForAdminFromSb',
    fancyMarketsUrl: 'https://adminapi.winzone.uk/sportsbook/getMasterFancyLadder',
    origin: 'https://admin.leoexch.co',

    loginBody(username, password) {
      return { username, password };
    },

    extractToken(json) {
      const token = json.data?.token;
      if (!token) throw new Error(json.message || json.error || 'Login failed - no token returned');
      // LeoExch tokens are hex strings, not JWTs - set 24h expiry
      const exp = Math.floor(Date.now() / 1000) + 86400;
      const userId = json.data?._id || json.data?.userId || null;
      return { token, userId, exp };
    },

    authHeader(token) {
      return { authorization: token };
    },

    marketsBody(client) {
      // LeoExch expects TotalBook/MyPT (no space)
      const bookView = client.book_view || 'Total Book';
      const bookType = bookView === 'Total Book' ? 'TotalBook' : bookView === 'My PT' ? 'MyPT' : bookView.replace(/\s/g, '');
      return {
        gameName: client.sports || 'All',
        bookType,
      };
    },

    userDetailsUrl: 'https://adminapi.winzone.uk/user/getOneUser',

    userDetailsBody() {
      return { userDetails: true };
    },

    extractUserId(json) {
      return json.data?.id || json.data?.accessId || null;
    },

    fancyMarketsBody(client) {
      const bookView = client.book_view || 'Total Book';
      const bookType = bookView === 'Total Book' ? 'TotalBook' : bookView === 'My PT' ? 'MyPT' : bookView.replace(/\s/g, '');
      return {
        userId: client.user_id,
        bookType,
        hierarchy: false,
      };
    },

    parseMarkets(json) {
      const events = json.data || [];
      // Each event has markets[] with bookExecuted keyed by selectionId
      return events.flatMap(event =>
        (event.markets || []).map(market => {
          const bookExecuted = market.bookExecuted || {};
          const runners = (market.runners || []).map(r => {
            const exposure = bookExecuted[r.selectionId] ?? bookExecuted[r._id] ?? 0;
            return {
              name: r.runnerName || r.name || r.selectionName || 'Unknown',
              exposure: typeof exposure === 'number' ? exposure : exposure.amount ?? exposure.exposure ?? 0,
            };
          });
          const netExposure = runners.reduce((max, r) => Math.max(max, Math.abs(r.exposure)), 0);
          return {
            id: market.marketId || `${event.eventName}-${market.marketName}`,
            eventName: event.eventName || event.gameName || 'Unknown',
            marketName: market.marketName || 'Unknown',
            netExposure,
            runners,
          };
        })
      );
    },

    parseFancyMarkets(json) {
      const events = json.data || [];
      return events.flatMap(event =>
        (event.market || []).map(market => {
          const ladder = market.ladderData || [];
          const runners = ladder.map(entry => {
            const start = entry.startScore || '0';
            const end = entry.endScore === 'Infinite' ? 'Inf' : (entry.endScore || '?');
            return {
              name: `${start}-${end}`,
              exposure: entry.amount ?? 0,
            };
          });
          return {
            id: `fancy-${event.eventName}-${market.marketName}`,
            eventName: event.eventName || 'Unknown',
            marketName: market.marketName || 'Unknown',
            netExposure: Math.abs(market.netExposure ?? 0),
            runners,
          };
        })
      );
    },
  },

  lotus: {
    name: 'Lotus',
    loginUrl: 'https://admin.lotusbookx247.com/api/auth/login',
    origin: 'https://admin.lotusbookx247.com',
    marketsMethod: 'GET',

    marketsUrl(client) {
      return `https://admin.lotusbookx247.com/api/agency/${client.user_id}/risk-mgmt/net-exposure`;
    },

    loginBody(username, password) {
      return { username, password, twoFacCode: '' };
    },

    extractToken(json, res) {
      if (!json.success) throw new Error(json.status?.statusDesc || 'Login failed');
      const token = res?.headers?.get?.('authorization');
      if (!token) throw new Error('Login failed - no token in response header');
      const user = json.result?.user;
      if (!user) throw new Error('Login failed - no user data');
      // JWT — decode for expiry
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'));
      const exp = payload.exp;
      const userId = user.name; // master name, used in API URLs
      return { token, userId, exp };
    },

    authHeader(token) {
      return { authorization: token };
    },

    marketsExtraHeaders(client) {
      return { 'x-user-id': client.user_id };
    },

    marketsBody() {
      return null;
    },

    isSessionExpired(json) {
      return !json.success && (
        json.status?.statusCode === '401' ||
        json.status?.statusDesc?.toLowerCase().includes('unauthorized') ||
        json.status?.statusDesc?.toLowerCase().includes('expired')
      );
    },

    parseMarkets(json, client) {
      const bookView = client?.book_view || 'Total Book';
      const events = [
        ...(json.result?.nonOutrights || []),
        ...(json.result?.outrights || []),
        ...(json.result?.betBuilders || []),
      ];

      return events.flatMap(event => {
        const allMarkets = [
          ...(event.matchOddsMarkets || []),
          ...(event.otherMarkets || []),
          ...(event.extraMarkets || []),
        ];

        return allMarkets.map(market => {
          const selections = market.selections || [];
          const runners = selections.map(s => {
            let exposure;
            if (bookView === 'My PT') {
              exposure = s.profitAndLoss ?? 0;
            } else if (bookView === 'Rate Book') {
              exposure = s.obrProfitAndLoss ?? 0;
            } else {
              exposure = s.totalProfitAndLoss ?? 0;
            }
            return {
              name: s.selectionName || `Runner ${s.selectionOrderIndex}`,
              exposure,
            };
          });

          const netExposure = runners.reduce((max, r) => Math.max(max, Math.abs(r.exposure)), 0);

          return {
            id: market.marketId || `${event.eventName}-${market.marketName}`,
            eventName: event.eventName || 'Unknown',
            marketName: market.marketName || 'Unknown',
            netExposure,
            runners,
          };
        });
      });
    },
  },
};

function getPlatform(name) {
  const platform = PLATFORMS[name];
  if (!platform) throw new Error(`Unknown platform: ${name}`);
  return platform;
}

module.exports = { PLATFORMS, getPlatform };
