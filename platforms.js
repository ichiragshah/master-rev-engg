const PLATFORMS = {
  winner7: {
    name: 'Winner7',
    loginUrl: 'https://user-backend-api.playexchwin.com/api/member/memberLogin',
    marketsUrl: 'https://artemis-bookmaker-v2.playexchwin.com/api/netExposure/getBooksForBackend',
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

    marketsBody(client) {
      return {
        eventType: client.sports || 'All',
        selectedType: client.book_view || 'Total Book',
        eventName: 'All',
      };
    },

    parseMarkets(json) {
      const outputArray = json.data?.data?.outputArray || [];
      const raw = outputArray.flatMap(event => event.data || []);
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
      return {
        gameName: client.sports || 'All',
        bookType: client.book_view || 'Total Book',
      };
    },

    parseMarkets(json) {
      const data = json.data || [];
      return data.map(item => {
        const runners = item.runners || [];
        const bookExecuted = item.bookExecuted || {};
        return {
          id: item._id || item.marketId || `${item.eventName}-${item.marketName}`,
          eventName: item.eventName || item.gameName || 'Unknown',
          marketName: item.marketName || 'Unknown',
          netExposure: Math.abs(item.netExposure ?? item.maxLoss ?? item.exposure ?? 0),
          runners: runners.map(r => {
            const executed = bookExecuted[r.selectionId] || bookExecuted[r._id] || {};
            return {
              name: r.runnerName || r.name || r.selectionName || 'Unknown',
              exposure: executed.amount ?? executed.exposure ?? r.amount ?? r.exposure ?? r.winLoss ?? r.pl ?? 0,
            };
          }),
        };
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
