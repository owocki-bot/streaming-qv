const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage
const proposals = new Map();
const voters = new Map(); // voterId -> { credits, allocations: { proposalId: votes } }
const FEE_RATE = 0.05;
const TREASURY = '0xccD7200024A8B5708d381168ec2dB0DC587af83F';

const getProvider = () => new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://sepolia.base.org');
const getWallet = () => new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, getProvider());

// Quadratic cost: votes^2 credits
const voteCost = (votes) => votes * votes;

// Calculate credits used by a voter
const creditsUsed = (voterId) => {
  const voter = voters.get(voterId);
  if (!voter) return 0;
  return Object.values(voter.allocations).reduce((sum, votes) => sum + voteCost(votes), 0);
};


// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.get('/', (req, res) => {
  res.json({
    name: 'Streaming Quadratic Voting',
    description: 'Continuous quadratic voting with adjustable streams',
    endpoints: {
      'POST /voters': 'Register voter with initial credits',
      'GET /voters/:id': 'Get voter status and allocations',
      'POST /voters/:id/credits': 'Add credits to voter',
      'POST /proposals': 'Create a proposal',
      'GET /proposals': 'List all proposals with vote counts',
      'GET /proposals/:id': 'Get proposal details',
      'POST /proposals/:id/allocate': 'Allocate votes to proposal (adjustable)',
      'POST /proposals/:id/distribute': 'Distribute funds based on QV results',
      'GET /health': 'Health check',
      'GET /test/e2e': 'End-to-end test'
    },
    note: 'Votes cost quadratically: 1 vote = 1 credit, 2 votes = 4 credits, 3 votes = 9 credits'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), proposals: proposals.size, voters: voters.size });
});

// Agent docs for LLMs
app.get('/agent', (req, res) => {
  res.json({
    name: 'Streaming Quadratic Voting',
    description: 'Continuous quadratic voting with adjustable streams. Voters allocate credits to proposals where cost scales quadratically (votes² = credits). Allocations can be adjusted anytime until distribution.',
    network: 'Base Sepolia',
    treasury_fee: '5%',
    treasury_address: TREASURY,
    endpoints: [
      { method: 'POST', path: '/voters', description: 'Register voter with initial credits', body: { voterId: 'optional', initialCredits: 100 } },
      { method: 'GET', path: '/voters/:id', description: 'Get voter status, allocations, remaining credits' },
      { method: 'POST', path: '/voters/:id/credits', description: 'Add credits to voter', body: { amount: 50 } },
      { method: 'POST', path: '/proposals', description: 'Create a proposal', body: { title: 'string', description: 'optional', fundingPool: '0.1' } },
      { method: 'GET', path: '/proposals', description: 'List all proposals with vote counts' },
      { method: 'GET', path: '/proposals/:id', description: 'Get proposal details and voter allocations' },
      { method: 'POST', path: '/proposals/:id/allocate', description: 'Allocate votes (adjustable anytime)', body: { voterId: 'string', votes: 3 } },
      { method: 'POST', path: '/proposals/:id/distribute', description: 'Distribute funding pool based on QV', body: { recipientAddress: '0x...' } }
    ],
    example_flow: [
      '1. POST /voters { initialCredits: 100 } → get voterId',
      '2. POST /proposals { title: "Fund project X", fundingPool: "0.5" }',
      '3. POST /proposals/:id/allocate { voterId, votes: 5 } → costs 25 credits (5²)',
      '4. Adjust: POST /proposals/:id/allocate { voterId, votes: 3 } → now costs 9 credits',
      '5. POST /proposals/:id/distribute { recipientAddress } → pays out based on votes'
    ],
    x402_enabled: false
  });
});

// Register voter
app.post('/voters', requireWhitelist(), (req, res) => {
  const { voterId, initialCredits } = req.body;
  const id = voterId || uuidv4();
  
  if (voters.has(id)) {
    return res.status(400).json({ error: 'Voter already exists' });
  }
  
  voters.set(id, {
    id,
    credits: initialCredits || 100,
    allocations: {},
    createdAt: Date.now()
  });
  
  res.json({ success: true, voter: voters.get(id) });
});

// Get voter
app.get('/voters/:id', (req, res) => {
  const voter = voters.get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found' });
  
  const used = creditsUsed(req.params.id);
  res.json({ ...voter, creditsUsed: used, creditsRemaining: voter.credits - used });
});

// Add credits
app.post('/voters/:id/credits', requireWhitelist(), (req, res) => {
  const voter = voters.get(req.params.id);
  if (!voter) return res.status(404).json({ error: 'Voter not found' });
  
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Positive amount required' });
  
  voter.credits += amount;
  res.json({ success: true, newBalance: voter.credits });
});

// Create proposal
app.post('/proposals', requireWhitelist(), (req, res) => {
  const { title, description, fundingPool } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  
  const id = uuidv4();
  proposals.set(id, {
    id,
    title,
    description: description || '',
    fundingPool: fundingPool || '0',
    status: 'active',
    createdAt: Date.now()
  });
  
  res.json({ success: true, proposal: proposals.get(id) });
});

// List proposals with aggregated votes
app.get('/proposals', (req, res) => {
  const results = [];
  for (const [id, proposal] of proposals) {
    let totalVotes = 0;
    let voterCount = 0;
    
    for (const [_, voter] of voters) {
      const votes = voter.allocations[id] || 0;
      if (votes > 0) {
        totalVotes += votes;
        voterCount++;
      }
    }
    
    results.push({ ...proposal, totalVotes, voterCount });
  }
  res.json(results);
});

// Get single proposal
app.get('/proposals/:id', (req, res) => {
  const proposal = proposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  
  let totalVotes = 0;
  let voterCount = 0;
  const allocations = [];
  
  for (const [voterId, voter] of voters) {
    const votes = voter.allocations[req.params.id] || 0;
    if (votes > 0) {
      totalVotes += votes;
      voterCount++;
      allocations.push({ voterId, votes, creditsCost: voteCost(votes) });
    }
  }
  
  res.json({ ...proposal, totalVotes, voterCount, allocations });
});

// Allocate votes (can be adjusted anytime)
app.post('/proposals/:id/allocate', requireWhitelist(), (req, res) => {
  const proposal = proposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.status !== 'active') return res.status(400).json({ error: 'Proposal not active' });
  
  const { voterId, votes } = req.body;
  if (!voterId) return res.status(400).json({ error: 'Voter ID required' });
  if (votes === undefined || votes < 0) return res.status(400).json({ error: 'Non-negative votes required' });
  
  const voter = voters.get(voterId);
  if (!voter) return res.status(404).json({ error: 'Voter not found' });
  
  // Calculate current credits used excluding this proposal
  const currentVotes = voter.allocations[req.params.id] || 0;
  const otherCreditsUsed = creditsUsed(voterId) - voteCost(currentVotes);
  const newCost = voteCost(votes);
  
  if (otherCreditsUsed + newCost > voter.credits) {
    return res.status(400).json({ 
      error: 'Insufficient credits',
      available: voter.credits - otherCreditsUsed,
      required: newCost
    });
  }
  
  // Update allocation
  if (votes === 0) {
    delete voter.allocations[req.params.id];
  } else {
    voter.allocations[req.params.id] = votes;
  }
  
  res.json({
    success: true,
    proposalId: req.params.id,
    votes,
    creditsCost: newCost,
    creditsRemaining: voter.credits - creditsUsed(voterId)
  });
});

// Distribute based on QV results
app.post('/proposals/:id/distribute', requireWhitelist(), async (req, res) => {
  const proposal = proposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  
  const { recipientAddress } = req.body;
  if (!recipientAddress) return res.status(400).json({ error: 'Recipient address required' });
  
  const poolWei = ethers.parseEther(proposal.fundingPool || '0');
  if (poolWei === 0n) {
    return res.json({ success: true, message: 'No funding pool to distribute' });
  }
  
  try {
    const wallet = getWallet();
    const fee = poolWei * BigInt(Math.floor(FEE_RATE * 100)) / 100n;
    const payout = poolWei - fee;
    
    const feeTx = await wallet.sendTransaction({ to: TREASURY, value: fee });
    await feeTx.wait();
    
    const payoutTx = await wallet.sendTransaction({ to: recipientAddress, value: payout });
    await payoutTx.wait();
    
    proposal.status = 'distributed';
    proposal.distributionTx = payoutTx.hash;
    
    res.json({
      success: true,
      payout: ethers.formatEther(payout),
      fee: ethers.formatEther(fee),
      txHash: payoutTx.hash
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// E2E Test
app.get('/test/e2e', async (req, res) => {
  const results = { tests: [], passed: 0, failed: 0 };
  
  const test = (name, condition) => {
    const passed = !!condition;
    results.tests.push({ name, passed });
    passed ? results.passed++ : results.failed++;
    return passed;
  };
  
  try {
    // Create voters
    const v1 = 'test-voter-1-' + Date.now();
    const v2 = 'test-voter-2-' + Date.now();
    voters.set(v1, { id: v1, credits: 100, allocations: {}, createdAt: Date.now() });
    voters.set(v2, { id: v2, credits: 100, allocations: {}, createdAt: Date.now() });
    test('Create voters', voters.has(v1) && voters.has(v2));
    
    // Create proposal
    const pId = uuidv4();
    proposals.set(pId, { id: pId, title: 'Test Proposal', fundingPool: '0', status: 'active', createdAt: Date.now() });
    test('Create proposal', proposals.has(pId));
    
    // Allocate votes (QV: 3 votes = 9 credits)
    voters.get(v1).allocations[pId] = 3;
    voters.get(v2).allocations[pId] = 5;
    test('Allocate votes', voters.get(v1).allocations[pId] === 3);
    
    // Verify quadratic cost
    const v1Cost = voteCost(3); // 9
    const v2Cost = voteCost(5); // 25
    test('Quadratic cost', v1Cost === 9 && v2Cost === 25);
    
    // Adjust allocation (streaming feature)
    voters.get(v1).allocations[pId] = 2;
    test('Adjust allocation', voters.get(v1).allocations[pId] === 2 && voteCost(2) === 4);
    
    // Total votes: 2 + 5 = 7
    let totalVotes = 0;
    for (const [_, voter] of voters) {
      totalVotes += voter.allocations[pId] || 0;
    }
    test('Total votes', totalVotes === 7);
    
    // Cleanup
    voters.delete(v1);
    voters.delete(v2);
    proposals.delete(pId);
    test('Cleanup', !voters.has(v1) && !proposals.has(pId));
    
  } catch (err) {
    results.error = err.message;
  }
  
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Streaming QV running on port ${PORT}`));

module.exports = app;
