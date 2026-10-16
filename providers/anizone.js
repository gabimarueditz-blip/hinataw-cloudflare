// Provider: anizone
export async function getEpisodes(id) {
  return {
    meta: { provider: "anizone" },
    episodes: {
      sub: [],
      dub: []
    }
  };
}

export default {
  async fetch(request) {
    return new Response(JSON.stringify({ streams: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
