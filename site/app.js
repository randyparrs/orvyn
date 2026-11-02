/*
  Orvyn static page: interface behavior.
  Loads data.json, renders the data driven parts, and runs the agent console replay,
  the demo tabs, the copy buttons, the collapsible transactions and the scroll animations.
  Every animation respects prefers-reduced-motion.
*/
(function () {
  'use strict';

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* Small helpers */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Formats data text: `code` becomes inline code, [label](#anchor) becomes a link. */
  function fmt(s) {
    var out = esc(s);
    out = out.replace(/\[([^\]]+)\]\((#[\w-]+|https?:\/\/[^)\s]+)\)/g, function (m, label, href) {
      return '<a href="' + href + '" data-link="inline-' + href.replace(/[^\w-]/g, '') + '">' + label + '</a>';
    });
    out = out.replace(/`([^`]+)`/g, '<code class="code-inline">$1</code>');
    return out;
  }

  function usdc(n) { return Number(n).toFixed(2) + ' USDC'; }
  function shortHash(tx) { return tx.slice(0, 6) + '\u2026' + tx.slice(-4); }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  var ICON = {
    check: '<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.3l2.4 2.4 4.6-5"/></svg>',
    arrowUpRight: '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l5-5M4.5 3.5h4v4"/></svg>',
    resultArrow: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 1.5v4h6M6 3.5l2 2-2 2"/></svg>'
  };

  function txUrl(data, network, tx) {
    return (network === 'genlayer' ? data.explorers.genlayer : data.explorers.arc) + '/tx/' + tx;
  }

  /* Generic data binding: [data-bind="path.to.value"] */
  function bindText(data) {
    $all('[data-bind]').forEach(function (node) {
      var v = node.getAttribute('data-bind').split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, data);
      if (v != null) node.textContent = v;
    });
  }

  /* Verdict block (light) */
  function verdictNode(v) {
    return el('div', { class: 'verdict' }, [
      el('div', { class: 'verdict-row' }, [
        el('span', { class: 'verdict-amount', text: usdc(v.refund_usdc) }),
        el('span', { class: 'verdict-pill', text: v.outcome })
      ]),
      el('span', { class: 'verdict-note', text: v.reason + (v.final ? ' \u00b7 final' : '') + (v.judge ? ' \u00b7 ' + v.judge : '') })
    ]);
  }

  /* 01 What Orvyn is */
  function renderWhat(data) {
    var sk = $('[data-render="what-session-key"]');
    data.what.sessionKey.forEach(function (r) {
      sk.appendChild(el('div', { class: 'kv-line' }, [
        el('span', { class: 'kv-line-k', text: r.label }),
        el('span', { class: 'kv-line-v', text: r.value })
      ]));
    });
    var cr = $('[data-render="what-claim-rules"]');
    data.what.claimRules.forEach(function (r) {
      cr.appendChild(el('span', null, [
        el('span', { class: 'j-key', text: r.event }),
        el('span', { class: 'j-punc', text: ': ' }),
        el('span', { class: 'j-val', text: '"' + r.mode + '"' })
      ]));
    });
    var vd = $('[data-render="what-verdict"]');
    var v = verdictNode(data.what.verdict);
    v.classList.add('vis-body');
    vd.replaceWith(v);
  }

  /* 02 How it works */
  function renderHow(data) {
    $('[data-render="how-payment-link"]').textContent = data.how.paymentLink;
  }

  /* 03 Connect an agent */
  function renderMcp(data) {
    var box = $('[data-render="mcp-variables"]');
    data.mcp.variables.forEach(function (v) {
      box.appendChild(el('div', { class: 'kv-row', 'data-variable': v.name }, [
        el('span', { class: 'kv-key', text: v.name }),
        el('span', { class: 'kv-val', html: fmt(v.description) })
      ]));
    });
    $('[data-render="mcp-config"]').textContent = JSON.stringify(data.mcp.clientConfig, null, 2);
  }

  /* 04 The six tools */
  function renderTools(data) {
    var grid = $('[data-render="tools"]');
    data.tools.forEach(function (t) {
      var inputs = el('div', { class: 'tool-inputs' });
      var row = el('div', { class: 'tool-inputs-row' }, [el('span', { class: 'inputs-label', text: 'inputs' })]);
      if (t.inputs.length) t.inputs.forEach(function (n) { row.appendChild(el('span', { class: 'in-chip', text: n })); });
      else row.appendChild(el('span', { class: 'muted-sm', text: 'none' }));
      if (t.inputsHint) row.appendChild(el('span', { class: 'muted-sm', text: t.inputsHint }));
      inputs.appendChild(row);
      if (t.inputsExtra) {
        var extra = el('div', { class: 'tool-inputs-row' }, [el('span', { class: 'muted-sm', text: t.inputsExtra.label })]);
        t.inputsExtra.names.forEach(function (n) { extra.appendChild(el('span', { class: 'in-chip', text: n })); });
        inputs.appendChild(extra);
      }
      if (t.inputsNote) inputs.appendChild(el('span', { class: 'muted-sm', html: fmt(t.inputsNote) }));
      grid.appendChild(el('article', { class: 'tool-card card', 'data-reveal': 'card', 'data-tool': t.name, id: 'tool-' + slug(t.name) }, [
        el('div', { class: 'tool-top' }, [
          el('span', { class: 'chip-tool', text: t.name }),
          el('span', { class: t.signs ? 'badge-signs' : 'badge-read', text: t.signs ? 'signs' : 'read only' })
        ]),
        el('p', { class: 'tool-line', text: t.summary }),
        t.details ? el('p', { class: 'tool-details', html: fmt(t.details) }) : null,
        inputs
      ]));
    });
  }

  /* 05 The owner's rules */
  function jsonHighlight(obj) {
    return JSON.stringify(obj, null, 2).split('\n').map(function (line) {
      var m = line.match(/^(\s*)("[^"]+")(:\s*)(.*?)(,?)$/);
      if (!m) return '<span class="j-punc">' + esc(line) + '</span>';
      var val = m[4] === '{' || m[4] === '[' ? '<span class="j-punc">' + m[4] + '</span>' : '<span class="j-val">' + esc(m[4]) + '</span>';
      return m[1] + '<span class="j-key">' + esc(m[2]) + '</span><span class="j-punc">' + m[3] + '</span>' + val + '<span class="j-punc">' + m[5] + '</span>';
    }).join('\n');
  }

  function renderRules(data) {
    var box = $('[data-render="rules-fields"]');
    data.rules.fields.forEach(function (f) {
      box.appendChild(el('div', { class: 'kv-row', 'data-field': f.name }, [
        el('span', { class: 'kv-key', text: f.name }),
        el('span', { class: 'kv-val', html: fmt(f.meaning) })
      ]));
    });
    $('[data-render="rules-json"]').innerHTML = jsonHighlight(data.rules.example);
  }

  /* 07 Demo: facts, tabs, conversation */
  function argsText(args) {
    var compact = '{' + Object.keys(args).map(function (k) { return JSON.stringify(k) + ': ' + JSON.stringify(args[k]); }).join(', ') + '}';
    return compact.length <= 64 ? compact : JSON.stringify(args, null, 2);
  }

  function streamItem(it) {
    if (it.type === 'call') {
      var row = el('div', { class: 'call-row' }, [el('span', { class: 'chip-tool', text: it.tool })]);
      if (it.ownerOk) row.appendChild(el('span', { class: 'owner-ok' }, [el('span', { class: 'owner-ok-check', html: ICON.check }), "Owner's OK"]));
      if (it.note) row.appendChild(el('span', { class: 'call-note', text: it.note }));
      return el('div', { class: 'item-call', 'data-item': 'call', 'data-tool': it.tool }, [row, it.args ? el('pre', { class: 'args', text: argsText(it.args) }) : null]);
    }
    if (it.type === 'ask') {
      var a = it.answer;
      return el('div', { class: 'ask', 'data-item': 'ask' }, [
        el('div', { class: 'ask-head' }, [el('span', { class: 'ask-title', text: 'Orvyn asks the owner' }), el('span', { class: 'ask-sub', text: 'MCP elicitation' })]),
        el('p', { class: 'ask-q', text: it.question }),
        el('div', { class: 'ask-answer' }, [
          el('span', { class: 'ask-answer-label', text: 'The owner answers:' }),
          a.approve ? el('span', { class: 'ans-chip ans-chip-primary', text: 'approve' }) : null,
          el('span', { class: 'ans-chip', text: 'kind: ' + a.proof_kind }),
          el('span', { class: 'ans-chip', text: JSON.stringify(a.proof) })
        ])
      ]);
    }
    return el('div', { class: 'agent-msg', 'data-item': 'agent' }, [el('span', { class: 'cap', text: 'Agent' }), el('p', { class: 'agent-text', text: it.text })]);
  }

  function initDemo(data) {
    var demo = data.demo;
    var facts = $('[data-render="demo-facts"]');
    demo.facts.forEach(function (f) {
      facts.appendChild(el('div', { class: 'fact', 'data-fact': slug(f.label) }, [el('span', { class: 'cap', text: f.label }), el('span', { class: 'fact-text', html: fmt(f.text) })]));
    });

    var tablist = $('[data-render="demo-tabs"]');
    var panel = $('[data-render="demo-stream"]');
    var prev = $('#demo-prev');
    var next = $('#demo-next');
    var atNode = $('[data-demo="at"]');
    var ownerNode = $('[data-demo="owner"]');
    var countNode = $('[data-demo="count"]');
    var current = 0;
    var tabs = demo.steps.map(function (s, i) {
      var b = el('button', {
        class: 'tab', type: 'button', role: 'tab', id: 'demo-tab-' + s.id.toLowerCase(),
        'aria-controls': 'demo-panel', 'aria-selected': 'false', tabindex: '-1',
        'data-action': 'demo-tab', 'data-tab': s.id
      }, [el('span', { class: 'tab-id', text: s.id }), el('span', { class: 'tab-at', text: s.at })]);
      b.addEventListener('click', function () { select(i, false); });
      tablist.appendChild(b);
      return b;
    });

    function select(i, focus) {
      if (i < 0 || i >= demo.steps.length) return;
      current = i;
      var s = demo.steps[i];
      tabs.forEach(function (t, n) {
        t.setAttribute('aria-selected', n === i ? 'true' : 'false');
        t.setAttribute('tabindex', n === i ? '0' : '-1');
      });
      if (focus) tabs[i].focus();
      panel.setAttribute('aria-labelledby', tabs[i].id);
      atNode.textContent = s.at;
      ownerNode.textContent = s.owner;
      countNode.textContent = s.id + ' of ' + demo.steps.length;
      prev.disabled = i === 0;
      next.disabled = i === demo.steps.length - 1;
      panel.textContent = '';
      s.items.forEach(function (it) { panel.appendChild(streamItem(it)); });
      panel.scrollTop = 0;
    }

    tablist.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); select(Math.min(current + 1, tabs.length - 1), true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); select(Math.max(current - 1, 0), true); }
      else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
      else if (e.key === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
    });
    prev.addEventListener('click', function () { select(current - 1, false); });
    next.addEventListener('click', function () { select(current + 1, false); });
    select(0, false);
  }

  /* 07 Demo: orders with collapsible transactions (one shared state keeps the cards level) */
  function renderOrders(data) {
    var grid = $('[data-render="orders"]');
    var open = false;
    var toggles = [];
    var lists = [];
    data.demo.orders.forEach(function (o) {
      var listId = 'transactions-' + o.order.toLowerCase();
      var list = el('ol', { class: 'tx-list', id: listId, hidden: true, 'data-transactions': o.order });
      o.timeline.forEach(function (r) {
        list.appendChild(el('li', { class: 'tx-row' + (r.tx ? '' : ' tx-row-offchain') }, [
          el('span', { class: 'tx-time', text: r.time }),
          el('span', { class: 'tx-what', text: r.what }),
          r.tx ? el('a', {
            class: 'tx-link', href: txUrl(data, r.network, r.tx), target: '_blank', rel: 'noopener',
            'data-link': 'tx-' + r.tx.slice(2, 10)
          }, [el('span', { class: 'tx-net', text: r.network === 'genlayer' ? 'GenLayer' : 'Arc' }), shortHash(r.tx), el('span', { html: ICON.arrowUpRight })]) : null
        ]));
      });
      var toggle = el('button', {
        class: 'tx-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': listId,
        'data-action': 'toggle-transactions', 'data-order': o.order, id: 'toggle-' + listId
      }, [el('span', { class: 'tx-toggle-label', text: 'Show transactions' }), el('span', { class: 'tx-count', text: String(o.timeline.length) })]);
      toggle.addEventListener('click', function () {
        open = !open;
        toggles.forEach(function (t) {
          t.setAttribute('aria-expanded', open ? 'true' : 'false');
          t.querySelector('.tx-toggle-label').textContent = open ? 'Hide transactions' : 'Show transactions';
        });
        lists.forEach(function (l) { l.hidden = !open; });
      });
      toggles.push(toggle);
      lists.push(list);

      var verdict = el('div', { class: 'order-verdict' }, [el('span', { class: 'vis-label', text: 'verdict' }), verdictNode(o.verdict)]);
      grid.appendChild(el('article', { class: 'order-card card', 'data-reveal': 'card', 'data-order': o.order, id: 'order-' + o.order.toLowerCase() }, [
        el('div', { class: 'order-head' }, [el('span', { class: 'order-id', text: o.order }), el('span', { class: 'order-claim', text: o.claim })]),
        el('div', { class: 'order-text' }, [el('span', { class: 'order-item', text: o.item }), el('span', { class: 'order-story', text: o.story })]),
        verdict, toggle, list
      ]));
    });
  }

  function renderTotals(data) {
    var box = $('[data-render="totals"]');
    data.demo.totals.forEach(function (t) {
      box.appendChild(el('div', { class: 'total', 'data-reveal': 'card', 'data-total': slug(t.value) }, [
        el('span', { class: 'total-value', text: t.value }),
        el('span', { class: 'total-label', text: t.label }),
        t.link ? el('a', {
          class: 'total-link', href: txUrl(data, t.link.network, t.link.tx), target: '_blank', rel: 'noopener', 'data-link': 'total-' + slug(t.link.label)
        }, [el('span', { class: 'tx-net', text: t.link.label }), shortHash(t.link.tx), el('span', { html: ICON.arrowUpRight })]) : null
      ]));
    });
  }

  /* 08 Network and contracts */
  function renderNetwork(data) {
    var card = $('[data-render="network"]');
    data.network.forEach(function (r) {
      var val = el('span', { class: 'net-val' });
      if (r.text) val.appendChild(el('span', { class: 'net-text', text: r.text }));
      if (r.mono) val.appendChild(el('span', { class: 'net-mono', text: r.mono }));
      (r.links || []).forEach(function (u) { val.appendChild(el('a', { href: u, target: '_blank', rel: 'noopener', 'data-link': 'explorer-' + slug(u.replace(/^https?:\/\//, '')), text: u })); });
      card.appendChild(el('div', { class: 'net-row', 'data-network-row': slug(r.label) }, [el('span', { class: 'net-label', text: r.label }), val]));
    });
  }

  /* Copy buttons */
  function initCopy(data) {
    var texts = {
      config: JSON.stringify(data.mcp.clientConfig, null, 2),
      rules: JSON.stringify(data.rules.example, null, 2)
    };
    $all('[data-action="copy"]').forEach(function (btn) {
      var timer;
      btn.addEventListener('click', function () {
        var text = texts[btn.getAttribute('data-copy')] || '';
        var done = function () {
          btn.textContent = 'Copied';
          clearTimeout(timer);
          timer = setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        } else { fallbackCopy(text); done(); }
      });
    });
  }

  function fallbackCopy(text) {
    var ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /* Agent console replay */
  function initConsole(cfg) {
    var root = $('#agent-console');
    var scroller = $('[data-console="scroller"]', root);
    var timeNode = $('[data-console="time"]', root);
    var turnNode = $('[data-console="turn"]', root);
    var bar = $('[data-console="bar"]', root);
    var track = $('[data-console="track"]', root);
    var toggleBtn = $('#console-toggle');
    var replayBtn = $('#console-replay');
    var L = cfg.lines;

    /* Typing time and pause after each line, scaled to the target duration */
    var weights = L.map(function (l) {
      var n = (l.text || '').length;
      switch (l.kind) {
        case 'owner': return [n / 48 * 1000, 700];
        case 'agent': return [n / 100 * 1000, 1150];
        case 'orvyn_asks_owner': return [n / 110 * 1000, 1500];
        case 'call': return [0, 560];
        case 'result': return [0, 440];
        case 'owner_ok': return [0, 820];
        case 'owner_answers': return [0, 1150];
        case 'verdict': return [0, 1600];
        default: return [0, 500];
      }
    });
    var sum = weights.reduce(function (s, w) { return s + w[0] + w[1]; }, 0);
    var k = cfg.durationMs / sum;
    var t = 350;
    var sched = weights.map(function (w) { var s = { start: t, type: w[0] * k }; t += (w[0] + w[1]) * k; return s; });
    var total = t + 3200;
    var ownerIdx = [];
    L.forEach(function (l, i) { if (l.kind === 'owner') ownerIdx.push(i); });

    var elapsed = reduceMotion ? total - 1 : 0;
    var playing = !reduceMotion;
    var rendered = -1;
    var typing = null;
    var lastTurn = -1;

    var markers = ownerIdx.map(function (oi, n) {
      var b = el('button', {
        class: 'console-marker', type: 'button', 'aria-label': 'Jump to owner message ' + (n + 1),
        title: L[oi].at, 'data-action': 'console-seek', 'data-turn': String(n + 1), id: 'console-seek-' + (n + 1)
      });
      b.style.left = 'calc(' + (sched[oi].start / total * 100) + '% - 7px)';
      b.addEventListener('click', function () { seek(oi); });
      track.appendChild(b);
      return b;
    });

    function fmtArgs(a) {
      var keys = Object.keys(a || {});
      if (!keys.length) return '{}';
      return '{' + keys.map(function (x) { return '"' + x + '": "' + a[x] + '"'; }).join(', ') + '}';
    }

    function label(text) { return el('span', { class: 'cl-label', text: text }); }

    /* Builds one console line. Returns the node and, for typed lines, the text holder. */
    function buildLine(l, isTyping) {
      var cls = reduceMotion ? '' : ' cl-in';
      var text = null;
      var node;
      switch (l.kind) {
        case 'owner':
          text = el('span');
          node = el('div', { class: 'cl-owner' + cls }, [
            el('div', { class: 'cl-divider', text: l.at }),
            el('div', { class: 'cl-right' }, [label('Owner'), el('div', { class: 'cl-bubble' }, [text])])
          ]);
          break;
        case 'agent':
          text = el('span');
          node = el('div', { class: 'cl-agent' + cls }, [
            el('div', { class: 'cl-agent-head' }, [label('Agent')]),
            el('div', { class: 'cl-agent-text' }, [text])
          ]);
          break;
        case 'call':
          node = el('div', { class: 'cl-call' + cls }, [el('span', { class: 'cl-call-tool', text: l.tool }), el('span', { class: 'cl-call-args', text: fmtArgs(l.args) })]);
          break;
        case 'result':
          node = el('div', { class: 'cl-result' + cls }, [el('span', { html: ICON.resultArrow }), el('span', { text: l.text })]);
          break;
        case 'owner_ok':
          node = el('div', { class: 'cl-ok' + cls }, [
            el('span', { class: 'cl-ok-check', html: ICON.check }),
            el('span', { class: 'cl-ok-text', text: l.text }),
            el('span', { class: 'cl-ok-tool', text: l.tool })
          ]);
          break;
        case 'orvyn_asks_owner':
          text = el('span');
          node = el('div', { class: 'cl-ask' + cls }, [
            el('div', { class: 'cl-ask-head' }, [label('Orvyn asks the owner'), el('span', { class: 'cl-ask-sub', text: 'MCP elicitation' })]),
            el('div', { class: 'cl-ask-text' }, [text])
          ]);
          break;
        case 'owner_answers':
          node = el('div', { class: 'cl-right' + cls }, [label('Owner answers'), el('div', { class: 'cl-answer', text: l.text })]);
          break;
        case 'verdict':
          node = el('div', { class: 'cl-verdict' + cls }, [
            el('span', { class: 'cl-verdict-label', text: 'verdict \u00b7 ' + l.order }),
            el('div', { class: 'cl-verdict-row' }, [
              el('span', { class: 'cl-verdict-amount', text: usdc(l.refund_usdc) }),
              el('span', { class: 'cl-verdict-pill', text: l.outcome })
            ]),
            el('span', { class: 'cl-verdict-note', text: l.reason + ' \u00b7 final' })
          ]);
          break;
        default:
          node = el('div');
      }
      var caret = null;
      if (text) {
        if (isTyping) { caret = el('span', { class: 'cl-caret', 'aria-hidden': 'true' }); text.parentNode.appendChild(caret); }
        else text.textContent = l.text;
      }
      return { node: node, text: text, caret: caret };
    }

    function pos(e) {
      var idx = -1;
      for (var i = 0; i < sched.length; i++) { if (sched[i].start <= e) idx = i; else break; }
      var chars = -1;
      if (idx >= 0 && !reduceMotion) {
        var s = sched[idx];
        if (s.type > 0) {
          var len = L[idx].text.length;
          var c = Math.floor((e - s.start) / s.type * len);
          if (c < len) chars = Math.max(0, c);
        }
      }
      return { idx: idx, chars: chars };
    }

    function finishTyping() {
      if (!typing) return;
      typing.text.textContent = L[typing.idx].text;
      if (typing.caret) typing.caret.remove();
      typing = null;
    }

    function sync() {
      var p = pos(elapsed);
      var changed = false;
      if (p.idx < rendered) { scroller.textContent = ''; rendered = -1; typing = null; }
      if (typing && (p.idx > typing.idx || p.chars < 0)) { finishTyping(); changed = true; }
      for (var i = rendered + 1; i <= p.idx; i++) {
        var isTyping = i === p.idx && p.chars >= 0;
        var line = buildLine(L[i], isTyping);
        scroller.appendChild(line.node);
        if (isTyping) typing = { idx: i, text: line.text, caret: line.caret, chars: -1 };
        changed = true;
      }
      if (p.idx > rendered) rendered = p.idx;
      if (typing && typing.idx === p.idx && p.chars >= 0 && p.chars !== typing.chars) {
        typing.chars = p.chars;
        typing.text.textContent = L[p.idx].text.slice(0, p.chars);
        changed = true;
      }
      if (changed && playing) scroller.scrollTop = scroller.scrollHeight;

      timeNode.textContent = p.idx >= 0 ? L[p.idx].at : L[0].at;
      var turn = 0;
      ownerIdx.forEach(function (oi, n) { if (oi <= p.idx) turn = n + 1; });
      if (turn !== lastTurn) {
        lastTurn = turn;
        turnNode.textContent = 'message ' + Math.max(turn, 1) + ' of ' + ownerIdx.length;
        markers.forEach(function (m, n) { m.classList.toggle('is-done', n < turn); });
      }
      bar.style.transform = 'scaleX(' + Math.min(1, elapsed / total) + ')';
    }

    function setPlaying(v) {
      playing = v;
      root.classList.toggle('is-playing', v);
      toggleBtn.setAttribute('aria-label', v ? 'Pause' : 'Play');
      toggleBtn.setAttribute('title', v ? 'Pause' : 'Play');
    }

    function seek(i) {
      elapsed = sched[i].start;
      sync();
      requestAnimationFrame(function () { scroller.scrollTop = scroller.scrollHeight; });
    }

    toggleBtn.addEventListener('click', function () {
      if (!playing && elapsed >= total - 2) elapsed = 0;
      setPlaying(!playing);
    });
    replayBtn.addEventListener('click', function () {
      elapsed = 0;
      scroller.scrollTop = 0;
      setPlaying(true);
      sync();
    });

    var last = null;
    function loop(now) {
      if (last === null) last = now;
      var dt = Math.min(100, now - last);
      last = now;
      if (playing) {
        elapsed += dt;
        if (elapsed >= total) { elapsed = 0; scroller.scrollTop = 0; }
        sync();
      }
      requestAnimationFrame(loop);
    }

    setPlaying(playing);
    sync();
    requestAnimationFrame(loop);
  }

  /* Scroll animations: play each time an element enters the screen, reset when it leaves */
  function initReveal() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    var els = $all('[data-reveal]');
    var vh = window.innerHeight;
    els.forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.top < vh * 0.94 && r.bottom > 0) e.classList.add('rv-instant', 'is-in');
    });
    document.documentElement.classList.add('motion');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { els.forEach(function (e) { e.classList.remove('rv-instant'); }); });
    });

    function hide(e) { e.classList.add('rv-instant'); e.classList.remove('is-in'); }

    var io = new IntersectionObserver(function (entries) {
      var show = [];
      entries.forEach(function (en) {
        var e = en.target;
        if (!en.isIntersecting) { if (e.classList.contains('is-in')) hide(e); return; }
        if (!e.classList.contains('is-in') && (en.intersectionRatio >= 0.12 || en.intersectionRect.height > 80)) show.push(e);
      });
      show.sort(function (a, b) { return (a.compareDocumentPosition(b) & 4) ? -1 : 1; });
      var h = 0;
      var c = 0;
      show.forEach(function (e) {
        var d = e.getAttribute('data-reveal') === 'card' ? 140 + Math.min(c++, 7) * 110 : Math.min(h++, 3) * 90;
        e.style.setProperty('--rv-delay', d + 'ms');
        e.classList.remove('rv-instant');
        void e.offsetWidth;
        e.classList.add('is-in');
      });
    }, { threshold: [0, 0.12, 0.25] });
    els.forEach(function (e) { io.observe(e); });
  }

  /* Subtle parallax on a few background glows */
  function initParallax() {
    if (reduceMotion) return;
    var items = $all('[data-parallax]');
    if (!items.length) return;
    var raf = null;
    function tick() {
      raf = null;
      var vh = window.innerHeight;
      items.forEach(function (node) {
        var r = node.parentElement.getBoundingClientRect();
        if (r.bottom < -200 || r.top > vh + 200) return;
        var off = (r.top + r.height / 2 - vh / 2) * parseFloat(node.getAttribute('data-parallax'));
        node.style.transform = 'translate3d(0,' + off.toFixed(1) + 'px,0)';
      });
    }
    function onScroll() { if (!raf) raf = requestAnimationFrame(tick); }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    tick();
  }

  /* Boot */
  function init(data) {
    bindText(data);
    renderWhat(data);
    renderHow(data);
    renderMcp(data);
    renderTools(data);
    renderRules(data);
    initDemo(data);
    renderOrders(data);
    renderTotals(data);
    renderNetwork(data);
    initCopy(data);
    initConsole(data.console);
    initReveal();
    initParallax();
  }

  function fail(err) {
    var scroller = $('[data-console="scroller"]');
    if (scroller) {
      scroller.appendChild(el('p', { class: 'console-error', text: 'Could not load the demo data.' }));
    }
    if (window.console) window.console.error(err);
  }

  function start() {
    fetch('data.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(init)
      .catch(fail);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
