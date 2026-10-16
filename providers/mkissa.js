// Provider: mkissa
export async function getEpisodes(id) {
  return {
    meta: { provider: "mkissa" },
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
