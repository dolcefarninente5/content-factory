// All cost/revenue assumptions live here so you can tune them as you get
// real numbers, instead of them being buried in agent code.
//
// RPM_PER_1000_VIEWS default reflects the benchmark we pulled from an
// actual running Darija storytelling channel (~$732/month on 1.83M
// monthly views = ~$0.40/1000). This is NOT the $12+ figure sometimes
// quoted for English-language betrayal/revenge content - that number is
// for a different market and does not apply here. Update this constant
// once you have your own AdSense data; until then it's a real but
// conservative external benchmark, not a guess.

const COST_MODEL = {
  // Per-unit costs - fill in real numbers once you've picked providers
  llmCostPer1kTokens: 0.01,       // Claude script drafting, adjust to your model/pricing
  ttsCostPerCharacter: 0.00003,   // placeholder - replace with your TTS provider's real rate
  imageCostPerImage: 0.04,        // placeholder - replace with your image provider's real rate
  imagesPerVideo: 6,              // how many distinct generated visuals per video

  // Revenue assumption - the single most important number to keep honest
  rpmPer1000Views: 0.40,

  // Fallback estimate for a channel with no history yet (new channel,
  // zero published videos to average from)
  fallbackEstViewsForNewChannel: 5000,
};

function estimateProductionCost({ scriptTokens = 800, scriptChars = 3000 }) {
  const llmCost = (scriptTokens / 1000) * COST_MODEL.llmCostPer1kTokens;
  const ttsCost = scriptChars * COST_MODEL.ttsCostPerCharacter;
  const imageCost = COST_MODEL.imagesPerVideo * COST_MODEL.imageCostPerImage;
  return {
    llmCost: round(llmCost),
    ttsCost: round(ttsCost),
    imageCost: round(imageCost),
    total: round(llmCost + ttsCost + imageCost),
  };
}

// Revenue estimate uses the channel's own rolling average views if we have
// one (i.e. real history), otherwise a conservative flat fallback. This is
// deliberately NOT a machine-learning prediction of "this specific story
// will get N views" - nothing can do that reliably before the video
// exists. It's "what has this channel actually been getting lately",
// which is the honest baseline to compare a story's estimated cost against.
function estimateRevenue({ channelAvgViews }) {
  const estViews = channelAvgViews || COST_MODEL.fallbackEstViewsForNewChannel;
  const estRevenue = (estViews / 1000) * COST_MODEL.rpmPer1000Views;
  return { estViews: Math.round(estViews), estRevenue: round(estRevenue) };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { COST_MODEL, estimateProductionCost, estimateRevenue };
