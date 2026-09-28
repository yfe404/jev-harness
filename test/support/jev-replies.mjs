// Deterministic contract fixtures only. These replies do not measure Jev accuracy.
export function responseFor({ choice = {}, noul = {}, score = {} } = {}) {
  return ({ questions }) => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { type: 'noul', noul: noul[key] ?? 0.05 }];
    if (q.type === 'choice') {
      const labels = Object.keys(q.criteria);
      const selected = choice[key] ?? labels.find(l => ['read_only', 'direct', 'none', 'one_off', 'unrelated'].includes(l)) ?? labels[0];
      return [key, { type: 'choice', choice: selected, confidence: 0.9,
        probabilities: Object.fromEntries(labels.map(label => [label, selected === label ? 1 : 0])) }];
    }
    if (q.type === 'score') {
      const value = score[key] ?? 0;
      return [key, { type: 'score', score: value, confidence: 0.9,
        probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === Math.round(value) ? 1 : 0])) }];
    }
    throw new Error(`unknown question ${key}`);
  })) });
}
