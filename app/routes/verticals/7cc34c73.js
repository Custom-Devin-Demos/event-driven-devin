const express = require('express');
const { filterExpenses, EXPENSES, REVIEW_QUEUES } = require('../../services/verticals/7cc34c73');

const router = express.Router();

/**
 * GET /api/7cc34c73/expenses — inbox bootstrap: ledger, review queues, filter values
 */
router.get('/api/7cc34c73/expenses', (_req, res) => {
  const distinct = (field) => [...new Set(EXPENSES.map((e) => e[field]))].sort();
  res.json({
    expenses: EXPENSES,
    queues: REVIEW_QUEUES.map((q) => ({
      id: q.id,
      label: q.label,
      count: q.states ? EXPENSES.filter((e) => q.states.includes(e.compliance)).length : EXPENSES.length,
    })),
    budgets: distinct('budget'),
    categories: distinct('category'),
    cards: distinct('card'),
  });
});

/**
 * POST /api/7cc34c73/expenses/filter — narrows the inbox by review queue + filters
 */
router.post('/api/7cc34c73/expenses/filter', async (req, res) => {
  try {
    const result = await filterExpenses({
      queue: req.body.queue || 'all',
      budget: req.body.budget || '',
      category: req.body.category || '',
      card: req.body.card || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'EXPENSE_FILTER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
