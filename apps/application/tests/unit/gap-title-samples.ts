/**
 * Scenario gap titles as their detectors write them (`shared/handlers/scenario-gaps.ts`),
 * with the French wording of each: the French report test checks the wording,
 * and the report languages test that every language rewrites every template.
 */

/** Before a colon. */
const NBSP = '\u00a0';
/** Inside « ». */
const NNBSP = '\u202f';

/** A title of each detector's template, in English and in French. */
export const GAP_TITLE_SAMPLES: Array<[detector: string, english: string, french: string]> = [
  [
    'success-only',
    'GET /api/orders/:id: documented 404/500 never tested',
    `GET /api/orders/:id${NBSP}: 404/500 documentés mais jamais testés`,
  ],
  [
    'success-only',
    'GET /api/orders: documented 404 never tested',
    `GET /api/orders${NBSP}: 404 documenté mais jamais testé`,
  ],
  [
    'success-only',
    'POST /api/orders: no error path under test',
    `POST /api/orders${NBSP}: aucun chemin d’erreur testé`,
  ],
  [
    'declared-never-hit',
    'Declared route DELETE /api/orders/:id — never reached',
    'Route DELETE /api/orders/:id déclarée, jamais atteinte',
  ],
  ['declared-never-hit', 'Declared page /billing — never reached', 'Page /billing déclarée, jamais atteinte'],
  [
    'single-covering-test',
    'Only one test reaches control checkout.pay',
    'Un seul test atteint le contrôle checkout.pay',
  ],
  ['single-covering-test', 'Only one test reaches route GET /api/cart', 'Un seul test atteint la route GET /api/cart'],
  [
    'single-covering-test',
    'No trusted test reaches page /settings/appearance',
    'Aucun test fiable n’atteint la page /settings/appearance',
  ],
  [
    'surface-drift',
    'New page /billing/plans — confirm it is tested',
    `Nouvelle page /billing/plans${NBSP}: vérifier qu’elle est testée`,
  ],
  [
    'surface-drift',
    'New handler orders.create — confirm it is tested',
    `Nouveau gestionnaire orders.create${NBSP}: vérifier qu’il est testé`,
  ],
  [
    'changed-unreached',
    'src/api/orders.post.ts changed but not reached',
    'Le fichier src/api/orders.post.ts a changé, mais aucun test ne l’atteint',
  ],
  [
    'control-nobody-exercises',
    'No test exercises control settings.save',
    'Aucun test n’utilise le contrôle settings.save',
  ],
  [
    'reachable-unvisited',
    '/billing/plans is linked but never visited',
    'La page /billing/plans est accessible par des liens, mais aucun test ne la visite',
  ],
  [
    'api-only-route',
    'POST /api/orders is reached only by request fixtures',
    'La route POST /api/orders n’est atteinte que par des requêtes d’API directes',
  ],
  ['not-noticed', 'Tests pass when POST /api/orders breaks', 'Les tests passent quand POST /api/orders tombe en panne'],
  ['unprobed-dependency', 'payments-svc is never probed', 'La dépendance payments-svc n’est jamais sondée'],
  [
    'not-handled',
    'payments-svc (via POST /api/orders): unhandled failure',
    `payments-svc (via POST /api/orders)${NBSP}: défaillance non gérée`,
  ],
  [
    'not-handled',
    'POST /api/orders: degraded failure',
    `POST /api/orders${NBSP}: fonctionnement dégradé en cas de défaillance`,
  ],
  ['matrix', 'Checkout: thin test matrix', `Checkout${NBSP}: matrice de tests trop réduite`],
  [
    'escaped-defect',
    'BUG-12 escaped the suite: Cart empties on refresh',
    `BUG-12 a échappé à la suite de tests${NBSP}: Cart empties on refresh`,
  ],
  [
    'orphan-test',
    'pays by card reaches only vanished surface',
    'pays by card n’atteint plus que des surfaces disparues',
  ],
  [
    'fix-did-not-hold',
    'A fix for "Timeout on pay" did not hold',
    `Un correctif de «${NNBSP}Timeout on pay${NNBSP}» n’a pas tenu`,
  ],
  [
    'phantom-coverage',
    'pays by card has not really run in 1 days',
    'pays by card n’a pas vraiment tourné depuis 1 jour',
  ],
  [
    'phantom-coverage',
    'pays by card has not really run in 12 days',
    'pays by card n’a pas vraiment tourné depuis 12 jours',
  ],
  ['passed-with-errors', 'pays by card passed with errors', 'pays by card a réussi malgré des erreurs'],
  ['catalog-method-no-test-calls', 'orders.refund is never called', 'La méthode orders.refund n’est jamais appelée'],
  [
    'incidental-catch',
    'src/cart.ts is caught only incidentally',
    'Les défauts de src/cart.ts ne sont détectés que par hasard',
  ],
  [
    'assertion-light',
    '/checkout is asserted only by visibility',
    'La page /checkout n’est vérifiée que par des assertions de visibilité',
  ],
  [
    'intent-without-test',
    'No test mentions "refund a partial order"',
    `Aucun test ne mentionne «${NNBSP}refund a partial order${NNBSP}»`,
  ],
  [
    'new-error-path',
    'POST /api/orders gains a 409 nobody tests',
    'La route POST /api/orders renvoie désormais un 409 qu’aucun test ne couvre',
  ],
  ['new-control', 'New control checkout.coupon on /checkout', 'Nouveau contrôle checkout.coupon sur /checkout'],
  [
    'fixed-without-test',
    'Bug report #7 was fixed without a regression test: Coupon applied twice',
    `Le rapport de bug n°${NBSP}7 a été corrigé sans test de non-régression${NBSP}: Coupon applied twice`,
  ],
];
