<?php
/**
 * Plugin Name: Dermedica Portal Fixes
 * Description: Lets the staff portal fix a word or phrase on a page (spelling, grammar, wording) and undo it. Works alongside Dermedica Portal Connector.
 * Version: 1.1.0
 */
if (!defined('ABSPATH')) exit;

const DPCFIX_NS = 'dermedica-portal/v1';
const DPCFIX_LOG = '_dpc_fix_log';
// Elementor settings that never hold readable text
const DPCFIX_SKIP_KEY = '/(^_|url|link|image|icon|^id$|css|class|colou?r|font|size|width|height|align|position|animation|motion|background|border|padding|margin|gap|style|tag$|type$|layout|view|selected|^source$|anchor|lightbox|video|embed|shortcode|^template)/i';

add_action('rest_api_init', function () {
  foreach (['find' => 'dpcfix_find', 'replace' => 'dpcfix_replace', 'undo' => 'dpcfix_undo', 'faq' => 'dpcfix_faq',
    'insert' => 'dpcfix_insert', 'link' => 'dpcfix_link', 'alt' => 'dpcfix_alt', 'seo' => 'dpcfix_seo',
    'href' => 'dpcfix_href', 'h1' => 'dpcfix_h1'] as $r => $cb) {
    register_rest_route(DPCFIX_NS, '/fix/' . $r, ['methods' => 'POST', 'callback' => $cb, 'permission_callback' => 'dpcfix_auth']);
  }
});

/* ---------- Who's asking: the portal's signed request (same scheme and key as the Connector) ---------- */

function dpcfix_auth(WP_REST_Request $req) {
  $key = defined('DPC_FIX_KEY') ? (string) DPC_FIX_KEY : '';
  if ($key === '') return new WP_Error('dpc_no_key', 'Add DPC_FIX_KEY to wp-config.php.', ['status' => 500]);
  $t = (string) $req->get_header('x-dpc-time');
  $sig = strtolower((string) $req->get_header('x-dpc-sig'));
  if (!ctype_digit($t) || abs(time() - (int) $t) > 300) return new WP_Error('dpc_time', 'The request is too old, or the clocks differ.', ['status' => 401]);
  $path = '/' . ltrim($req->get_route(), '/');
  $want = hash_hmac('sha256', $t . "\n" . strtoupper($req->get_method()) . "\n" . $path . "\n" . hash('sha256', $req->get_body()), $key);
  if (!hash_equals($want, $sig)) return new WP_Error('dpc_sig', 'The signature does not match. Check DPC_FIX_KEY is the same as WP_PORTAL_KEY.', ['status' => 401]);
  $once = 'dpcfix_' . substr($sig, 0, 40);
  if (get_transient($once)) return new WP_Error('dpc_replay', 'This request was already used.', ['status' => 401]);
  set_transient($once, 1, 600);
  dpcfix_as_admin();
  return true;
}

// Changes are made as an administrator (DPC_FIX_USER, or the first admin), so WordPress keeps the page's HTML as it is
function dpcfix_as_admin() {
  if (get_current_user_id()) return;
  $u = defined('DPC_FIX_USER') ? get_user_by('login', DPC_FIX_USER) : null;
  if (!$u) { $list = get_users(['role' => 'administrator', 'number' => 1, 'orderby' => 'ID']); $u = $list ? $list[0] : null; }
  if ($u) wp_set_current_user($u->ID);
}

function dpcfix_no($code, $msg, $extra = []) { return array_merge(['ok' => false, 'code' => $code, 'message' => $msg], $extra); }

/* ---------- Finding the words in the page's HTML ---------- */

// Curly quotes, long dashes and odd spaces count as the plain ones (capitals kept)
function dpcfix_fold_char($ch) {
  static $map = ["\u{2018}" => "'", "\u{2019}" => "'", "\u{02BC}" => "'", '`' => "'", "\u{201C}" => '"', "\u{201D}" => '"',
    "\u{2013}" => '-', "\u{2014}" => '-', "\u{00A0}" => ' '];
  if (isset($map[$ch])) $ch = $map[$ch];
  if (preg_match('/^\s$/u', $ch)) return ' ';
  return $ch;
}
function dpcfix_norm_char($ch) { return mb_strtolower(dpcfix_fold_char($ch), 'UTF-8'); }

// The text of an HTML string as people read it, and where each character came from (byte offsets).
// Returns [lower-case text, starts[], ends[], each character with its capitals kept]
function dpcfix_index($src) {
  $chars = []; $orig = []; $st = []; $en = [];
  $block = '/^<\/?(p|br|li|ul|ol|h[1-6]|div|section|tr|td|th|blockquote|figure|figcaption)\b/i';
  preg_match_all('/<!--.*?-->|<[^>]*>|&#?[a-z0-9]+;|./su', (string) $src, $m, PREG_OFFSET_CAPTURE);
  foreach ($m[0] as $tk) {
    $tok = $tk[0]; $off = $tk[1]; $end = $off + strlen($tok);
    if ($tok[0] === '<' && strlen($tok) > 1) {
      if (preg_match($block, $tok) && $chars && end($chars) !== ' ') { $chars[] = ' '; $orig[] = ' '; $st[] = $off; $en[] = $end; }
      continue;
    }
    $txt = ($tok[0] === '&' && strlen($tok) > 1) ? html_entity_decode($tok, ENT_QUOTES | ENT_HTML5, 'UTF-8') : $tok;
    foreach (preg_split('//u', $txt, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
      $f = dpcfix_fold_char($ch);
      $c = mb_strtolower($f, 'UTF-8');
      if ($c === ' ' && (!$chars || end($chars) === ' ')) continue;
      $chars[] = $c; $orig[] = $f; $st[] = $off; $en[] = $end;
    }
  }
  return [implode('', $chars), $st, $en, $orig];
}

// The smallest change: only the characters that differ between the page and the new wording, so formatting
// around them (bold, links) is kept. keepCase (spelling): capitals on the page stay as they are.
// Returns [start, end, new HTML], or null when the part that changes has formatting inside it.
function dpcfix_edit($src, $st, $en, $orig, $at, $n, $rep, $keepCase) {
  $pc = array_slice($orig, $at, $n);                                  // the words on the page
  $rc = preg_split('//u', $rep, -1, PREG_SPLIT_NO_EMPTY);             // the new words
  $rf = array_map('dpcfix_fold_char', $rc);
  $same = function ($x, $y) use ($keepCase) {
    return $keepCase ? mb_strtolower($x, 'UTF-8') === mb_strtolower($y, 'UTF-8') : $x === $y;
  };
  $m = count($rc);
  $p = 0;
  while ($p < $n && $p < $m && $same($pc[$p], $rf[$p])) $p++;
  $s = 0;
  while ($s < $n - $p && $s < $m - $p && $same($pc[$n - 1 - $s], $rf[$m - 1 - $s])) $s++;
  $mid = htmlspecialchars(implode('', array_slice($rc, $p, $m - $p - $s)), ENT_NOQUOTES, 'UTF-8');
  if ($n - $p - $s === 0) {                                           // only adding words
    $pos = $p > 0 ? $en[$at + $p - 1] : $st[$at];
    return [$pos, $pos, $mid];
  }
  $a = $st[$at + $p];
  $b = $en[$at + $n - $s - 1];
  if (strpos(substr($src, $a, $b - $a), '<') !== false) return null;  // formatting inside the part that changes
  return [$a, $b, $mid];
}

function dpcfix_needle($text) { return trim(dpcfix_index(htmlspecialchars((string) $text, ENT_NOQUOTES, 'UTF-8'))[0]); }

// Each place the words appear (whole words only): byte range, whether formatting is inside it,
// the words as written on the page, and the sentence around them (capitals kept)
function dpcfix_hits($src, $needle) {
  if ($needle === '' || !is_string($src) || $src === '') return [];
  list($plain, $st, $en, $orig) = dpcfix_index($src);
  $out = []; $from = 0; $n = mb_strlen($needle, 'UTF-8');
  $word = '/[\p{L}\p{N}]/u';
  $edgeL = preg_match($word, mb_substr($needle, 0, 1, 'UTF-8'));
  $edgeR = preg_match($word, mb_substr($needle, -1, 1, 'UTF-8'));
  while (($at = mb_strpos($plain, $needle, $from, 'UTF-8')) !== false) {
    $from = $at + 1;
    if ($edgeL && $at > 0 && preg_match($word, mb_substr($plain, $at - 1, 1, 'UTF-8'))) continue;
    if ($edgeR && preg_match($word, mb_substr($plain, $at + $n, 1, 'UTF-8'))) continue;
    $a = $st[$at]; $b = $en[$at + $n - 1];
    $c0 = max(0, $at - 60);
    $out[] = ['a' => $a, 'b' => $b, 'at' => $at, 'n' => $n, 'tags' => strpos(substr($src, $a, $b - $a), '<') !== false,
      'match' => implode('', array_slice($orig, $at, $n)),
      'ctx' => implode('', array_slice($orig, $c0, $at - $c0 + $n + 60))];
    $from = $at + $n;
  }
  return $out;
}
// Where the page's words are kept: Elementor's data for Elementor pages, otherwise the post content
function dpcfix_targets($id) {
  $t = [];
  if (get_post_meta($id, '_elementor_edit_mode', true) === 'builder') {
    $raw = get_post_meta($id, '_elementor_data', true);
    $data = is_string($raw) ? json_decode($raw, true) : (is_array($raw) ? $raw : null);
    if (is_array($data)) dpcfix_walk($data, [], false, $t);
    return [$t, true, $data];
  }
  $p = get_post($id);
  if ($p) $t[] = ['path' => [], 'value' => $p->post_content];
  return [$t, false, null];
}

function dpcfix_walk($node, $path, $inSettings, &$out) {
  foreach ($node as $k => $v) {
    $p = array_merge($path, [$k]);
    if (is_array($v)) dpcfix_walk($v, $p, $inSettings || $k === 'settings', $out);
    elseif ($inSettings && is_string($v) && is_string($k) && !preg_match(DPCFIX_SKIP_KEY, $k) && preg_match('/\p{L}{2}/u', $v)) {
      $out[] = ['path' => $p, 'value' => $v];
    }
  }
}

function dpcfix_all_hits($targets, $needle) {
  $hits = [];
  foreach ($targets as $i => $t) foreach (dpcfix_hits($t['value'], $needle) as $h) { $h['t'] = $i; $hits[] = $h; }
  return $hits;
}

function &dpcfix_ref(array &$arr, array $path) { $r = &$arr; foreach ($path as $k) { $r = &$r[$k]; } return $r; }
function dpcfix_get($arr, $path) {
  foreach ($path as $k) { if (!is_array($arr) || !array_key_exists($k, $arr)) return null; $arr = $arr[$k]; }
  return $arr;
}

function dpcfix_save_content($id, $html) {
  kses_remove_filters();
  $r = wp_update_post(['ID' => $id, 'post_content' => wp_slash($html)], true);
  kses_init();
  return $r;
}

function dpcfix_save_elementor($id, $data) {
  update_post_meta($id, '_elementor_data', wp_slash(wp_json_encode($data)));
  delete_post_meta($id, '_elementor_element_cache');
  kses_remove_filters(); wp_update_post(['ID' => $id]); kses_init();   // new "last modified" date and the usual save hooks
}

// WP-Optimize: clear this page's cached copy
function dpcfix_purge($id) {
  clean_post_cache($id);
  if (class_exists('WPO_Page_Cache')) {
    if (method_exists('WPO_Page_Cache', 'delete_single_post_cache')) WPO_Page_Cache::delete_single_post_cache($id);
    elseif (method_exists('WPO_Page_Cache', 'delete_cache_by_url')) WPO_Page_Cache::delete_cache_by_url(get_permalink($id));
  }
}

function dpcfix_log($id, $e) {
  $log = get_post_meta($id, DPCFIX_LOG, true);
  if (!is_array($log)) $log = [];
  array_unshift($log, $e);
  update_post_meta($id, DPCFIX_LOG, wp_slash(array_slice($log, 0, 8)));
}

/* ---------- The routes ---------- */

// Looks only: how many times the words appear, and where. Changes nothing.
function dpcfix_find(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0); $find = trim((string) ($b['find'] ?? ''));
  if (!$id || !get_post($id) || $find === '') return dpcfix_no('bad', 'Nothing to look for.');
  list($targets, $isEl) = dpcfix_targets($id);
  $hits = dpcfix_all_hits($targets, dpcfix_needle($find));
  return ['ok' => true, 'elementor' => $isEl, 'count' => count($hits), 'hits' => array_map(function ($h) {
    return ['formatted' => $h['tags'], 'context' => $h['ctx'], 'match' => $h['match']];
  }, array_slice($hits, 0, 20))];
}

// Changes the words. Exactly one place, unless "all" (spelling: every place the misspelt word appears).
// Only the characters that differ are replaced, so formatting around them stays.
function dpcfix_replace(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $find = trim((string) ($b['find'] ?? '')); $rep = trim(preg_replace('/\s+/u', ' ', (string) ($b['replace'] ?? '')));
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  $all = !empty($b['all']);
  $keep = !empty($b['keepCase']);
  $skipCaps = !empty($b['skipCaps']);   // words written in capitals (headings) are left as they are
  $post = $id ? get_post($id) : null;
  if (!$post) return dpcfix_no('not_found', "That page isn't in WordPress.");
  if ($find === '' || $rep === '' || mb_strlen($find) > 1500 || mb_strlen($rep) > 2000 || !$fid) return dpcfix_no('bad', 'Nothing to change.');

  list($targets, $isEl, $data) = dpcfix_targets($id);
  $hits = dpcfix_all_hits($targets, dpcfix_needle($find));
  if (!$hits) return dpcfix_no('not_found', 'Not found in the page.');
  if (count($hits) > 1 && !$all) return dpcfix_no('many', 'Found more than once.', ['count' => count($hits)]);
  if (count($hits) > 20) return dpcfix_no('many', 'Found too many times.', ['count' => count($hits)]);

  $byT = [];
  foreach ($hits as $h) $byT[$h['t']][] = $h;
  $changes = [];
  foreach ($byT as $ti => $hs) {
    $v = $targets[$ti]['value'];
    list(, $st, $en, $orig) = dpcfix_index($v);
    $edits = [];
    foreach ($hs as $h) {
      if ($skipCaps && preg_match('/\p{L}/u', $h['match']) && $h['match'] === mb_strtoupper($h['match'], 'UTF-8')) continue;
      $e = dpcfix_edit($v, $st, $en, $orig, $h['at'], $h['n'], $rep, $keep);
      if (!$e) return dpcfix_no('formatted', 'Formatting inside the part that changes.', ['context' => $h['ctx']]);
      $edits[] = $e;
    }
    usort($edits, function ($x, $y) { return $y[0] - $x[0]; });   // from the end, so earlier positions stay right
    foreach ($edits as $e) $v = substr_replace($v, $e[2], $e[0], $e[1] - $e[0]);
    if ($v !== $targets[$ti]['value']) $changes[] = ['path' => $targets[$ti]['path'], 'before' => $targets[$ti]['value'], 'after' => $v];
  }
  if (!$changes) return dpcfix_no('same', 'The new wording is the same as what the page says.');

  $entry = ['fid' => $fid, 'at' => time(), 'where' => $isEl ? 'elementor' : 'content', 'find' => $find, 'replace' => $rep];
  if ($isEl) {
    foreach ($changes as $c) { $ref = &dpcfix_ref($data, $c['path']); $ref = $c['after']; unset($ref); }
    dpcfix_save_elementor($id, $data);
    $entry['changes'] = $changes;
  } else {
    $r = dpcfix_save_content($id, $changes[0]['after']);
    if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    $entry['before'] = $changes[0]['before'];
    $entry['after_hash'] = md5(get_post($id)->post_content);
  }
  dpcfix_log($id, $entry);
  dpcfix_purge($id);
  return ['ok' => true, 'where' => $entry['where'], 'count' => count($hits), 'link' => get_permalink($id), 'context' => $hits[0]['ctx']];
}


// Puts a change back, if the page hasn't been edited since
function dpcfix_undo(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0); $fid = (string) ($b['fid'] ?? '');
  $log = get_post_meta($id, DPCFIX_LOG, true);
  if (!is_array($log)) return dpcfix_no('not_found', 'No changes to undo on this page.');
  foreach ($log as $i => $e) {
    if (($e['fid'] ?? '') !== $fid) continue;
    if (!empty($e['undone'])) return dpcfix_no('done', 'Already undone.');
    if ($e['where'] === 'seo') {
      list($via, $now) = dpcfix_seo_get($id, $e['field']);
      if (!$via) return dpcfix_no('no_seo', 'No SEO plugin found.');
      if ((string) $now !== (string) $e['after']) return dpcfix_no('changed', 'Edited since.');
      dpcfix_seo_put($id, $e['field'], (string) $e['before']);
    } elseif ($e['where'] === 'alt') {
      if (($e['kind'] ?? '') === 'el') {
        $data = json_decode((string) get_post_meta($id, '_elementor_data', true), true);
        if (!is_array($data)) return dpcfix_no('changed', 'Elementor data unreadable.');
        foreach ($e['changes'] as $c) if (dpcfix_get($data, $c['path']) !== $c['after']) return dpcfix_no('changed', 'Edited since.');
        foreach ($e['changes'] as $c) { $ref = &dpcfix_ref($data, $c['path']); $ref = $c['before']; unset($ref); }
        dpcfix_save_elementor($id, $data);
      } elseif (($e['kind'] ?? '') === 'content') {
        $p = get_post($id);
        if (!$p || md5($p->post_content) !== $e['after_hash']) return dpcfix_no('changed', 'Edited since.');
        $r = dpcfix_save_content($id, $e['before']);
        if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
      }
      foreach ((array) ($e['metas'] ?? []) as $m) update_post_meta((int) $m['aid'], '_wp_attachment_image_alt', wp_slash((string) $m['before']));
    } elseif ($e['where'] === 'insert') {
      if ($e['kind'] === 'el') {
        if (md5((string) get_post_meta($id, '_elementor_data', true)) !== $e['after_hash']) return dpcfix_no('changed', 'Edited since.');
        update_post_meta($id, '_elementor_data', wp_slash($e['before']));
        delete_post_meta($id, '_elementor_element_cache');
      } else {
        $p = get_post($id);
        if (!$p || md5($p->post_content) !== $e['after_hash']) return dpcfix_no('changed', 'Edited since.');
        $r = dpcfix_save_content($id, $e['before']);
        if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
      }
      if (array_key_exists('faq_before', $e)) {
        if (!empty($e['faq_before'])) update_post_meta($id, '_dpc_faq', wp_slash($e['faq_before'])); else delete_post_meta($id, '_dpc_faq');
      }
    } elseif ($e['where'] === 'faq') {
      $cur = get_post_meta($id, '_dpc_faq', true);
      if (md5(wp_json_encode(is_array($cur) ? $cur : [])) !== $e['after_hash']) return dpcfix_no('changed', 'Edited since.');
      if (!empty($e['before'])) update_post_meta($id, '_dpc_faq', wp_slash($e['before'])); else delete_post_meta($id, '_dpc_faq');
    } elseif ($e['where'] === 'elementor') {
      $data = json_decode((string) get_post_meta($id, '_elementor_data', true), true);
      if (!is_array($data)) return dpcfix_no('changed', 'Elementor data unreadable.');
      foreach ($e['changes'] as $c) if (dpcfix_get($data, $c['path']) !== $c['after']) return dpcfix_no('changed', 'Edited since.');
      foreach ($e['changes'] as $c) { $ref = &dpcfix_ref($data, $c['path']); $ref = $c['before']; unset($ref); }
      dpcfix_save_elementor($id, $data);
    } else {
      $p = get_post($id);
      if (!$p || md5($p->post_content) !== $e['after_hash']) return dpcfix_no('changed', 'Edited since.');
      $r = dpcfix_save_content($id, $e['before']);
      if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    }
    $log[$i]['undone'] = time();
    update_post_meta($id, DPCFIX_LOG, wp_slash($log));
    dpcfix_purge($id);
    return ['ok' => true, 'link' => get_permalink($id)];
  }
  return dpcfix_no('not_found', "That change isn't in the page's history (the last 8 are kept).");
}

/* ---------- FAQ schema: the questions and answers already on a page, for Google ---------- */

// Saves the page's questions and answers (the portal reads them from the live page)
function dpcfix_faq(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  if (!$id || !get_post($id) || !$fid) return dpcfix_no('bad', 'Nothing to save.');
  $clean = [];
  foreach ((array) ($b['faqs'] ?? []) as $x) {
    $q = trim(wp_strip_all_tags((string) ($x['q'] ?? '')));
    $a = trim(wp_strip_all_tags((string) ($x['a'] ?? '')));
    if ($q !== '' && $a !== '') $clean[] = ['q' => mb_substr($q, 0, 300), 'a' => mb_substr($a, 0, 1500)];
    if (count($clean) >= 20) break;
  }
  $before = get_post_meta($id, '_dpc_faq', true);
  if ($clean) update_post_meta($id, '_dpc_faq', wp_slash($clean)); else delete_post_meta($id, '_dpc_faq');
  dpcfix_log($id, ['fid' => $fid, 'at' => time(), 'where' => 'faq', 'before' => is_array($before) ? $before : [],
    'after_hash' => md5(wp_json_encode($clean))]);
  dpcfix_purge($id);
  return ['ok' => true, 'count' => count($clean), 'link' => get_permalink($id)];
}

// Shows them to Google as FAQPage schema
add_action('wp_head', function () {
  if (!is_singular()) return;
  $faq = get_post_meta(get_queried_object_id(), '_dpc_faq', true);
  if (!is_array($faq) || !$faq) return;
  $items = [];
  foreach ($faq as $x) {
    $items[] = ['@type' => 'Question', 'name' => $x['q'], 'acceptedAnswer' => ['@type' => 'Answer', 'text' => $x['a']]];
  }
  echo "\n" . '<script type="application/ld+json" id="dpc-faq">'
    . wp_json_encode(['@context' => 'https://schema.org', '@type' => 'FAQPage', 'mainEntity' => $items], JSON_UNESCAPED_UNICODE)
    . "</script>\n";
}, 30);

/* ---------- Adding a section: an FAQ, or the "medically reviewed by" line ---------- */

// The new section as HTML, or as WordPress blocks. parts: [{ t: h2 | h3 | p | note, x: text }]
function dpcfix_parts_html($parts, $blocks) {
  $out = '';
  foreach ($parts as $p) {
    $t = (string) ($p['t'] ?? '');
    $x = esc_html(mb_substr(trim((string) ($p['x'] ?? '')), 0, 1500));
    if ($x === '') continue;
    if ($t === 'h2' || $t === 'h3') {
      $lv = $t === 'h2' ? 2 : 3;
      $h = '<h' . $lv . ($blocks ? ' class="wp-block-heading"' : '') . '>' . $x . '</h' . $lv . '>';
      $out .= $blocks ? '<!-- wp:heading' . ($lv === 3 ? ' {"level":3}' : '') . " -->\n" . $h . "\n<!-- /wp:heading -->\n\n" : $h . "\n";
    } else {
      $note = $t === 'note';
      $pp = '<p' . ($note ? ' class="dpc-reviewed"' : '') . '>' . ($note ? '<em>' . $x . '</em>' : $x) . '</p>';
      $out .= $blocks ? ($note ? '<!-- wp:paragraph {"className":"dpc-reviewed"} -->' : '<!-- wp:paragraph -->') . "\n" . $pp . "\n<!-- /wp:paragraph -->\n\n" : $pp . "\n";
    }
  }
  return $out;
}

// Normal pages: before a heading, after the main heading (top), or at the end. null when the heading isn't there.
function dpcfix_insert_content($content, $where, $html) {
  if ($where === 'end') return rtrim($content) . "\n\n" . $html;
  preg_match_all('/(?:<!--\s*wp:heading\b[^>]*-->\s*)?<h([1-6])\b[^>]*>(.*?)<\/h\1\s*>/is', $content, $m, PREG_OFFSET_CAPTURE | PREG_SET_ORDER);
  if ($where === 'top') {
    foreach ($m as $x) {
      if ($x[1][0] !== '1') continue;
      $pos = $x[0][1] + strlen($x[0][0]);
      if (preg_match('/^\s*<!--\s*\/wp:heading\s*-->/', substr($content, $pos), $mm)) $pos += strlen($mm[0]);
      return substr($content, 0, $pos) . "\n\n" . $html . substr($content, $pos);
    }
    return $html . "\n" . $content;   // the main heading comes from the theme: start of the page's content
  }
  if (strpos($where, 'before:') === 0) {
    $want = dpcfix_needle(substr($where, 7));
    foreach ($m as $x) {
      if (trim(dpcfix_index($x[2][0])[0]) === $want) return substr($content, 0, $x[0][1]) . $html . "\n" . substr($content, $x[0][1]);
    }
  }
  return null;
}

// Elementor: a new text block before a heading, after the main heading (top), or after the last block (end)
function dpcfix_insert_el(&$data, $where, $html) {
  $want = strpos($where, 'before:') === 0 ? dpcfix_needle(substr($where, 7)) : '';
  $found = null; $first = null; $last = null;
  $walk = function ($els, $path) use (&$walk, &$found, &$first, &$last, $where, $want) {
    foreach ($els as $i => $el) {
      if ($found) return;
      if (!is_array($el)) continue;
      if (($el['elType'] ?? '') === 'widget') {
        if (!$first) $first = [$path, $i];
        $last = [$path, $i];
        $s = is_array($el['settings'] ?? null) ? $el['settings'] : [];
        $type = (string) ($el['widgetType'] ?? '');
        $ed = isset($s['editor']) && is_string($s['editor']) ? $s['editor'] : '';
        if ($where === 'top') {
          if (($type === 'heading' && ($s['header_size'] ?? '') === 'h1') || $type === 'theme-post-title' || preg_match('/<h1\b/i', $ed)) {
            $found = ['after', $path, $i]; return;
          }
        } elseif ($want !== '') {
          if ($type === 'heading' && trim(dpcfix_index((string) ($s['title'] ?? ''))[0]) === $want) { $found = ['before', $path, $i]; return; }
          if ($ed !== '' && preg_match_all('/<h([1-6])\b[^>]*>(.*?)<\/h\1\s*>/is', $ed, $mm, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
            foreach ($mm as $x) {
              if (trim(dpcfix_index($x[2][0])[0]) === $want) { $found = ['inside', $path, $i, $x[0][1]]; return; }
            }
          }
        }
      }
      if (!empty($el['elements']) && is_array($el['elements'])) $walk($el['elements'], array_merge($path, [$i, 'elements']));
    }
  };
  $walk($data, []);
  if (!$found && $where === 'end' && $last) $found = ['after', $last[0], $last[1]];
  if (!$found && $where === 'top' && $first) $found = ['before', $first[0], $first[1]];
  if (!$found || !$found[1]) return false;
  if ($found[0] === 'inside') {   // the heading is inside a text block: put it straight before the heading
    $ed = &dpcfix_ref($data, array_merge($found[1], [$found[2], 'settings', 'editor']));
    $ed = substr($ed, 0, $found[3]) . $html . substr($ed, $found[3]);
    unset($ed);
    return true;
  }
  $widget = ['id' => substr(md5(uniqid('', true)), 0, 7), 'elType' => 'widget', 'widgetType' => 'text-editor',
    'settings' => ['editor' => $html], 'elements' => [], 'isInner' => false];
  $arr = &dpcfix_ref($data, $found[1]);
  array_splice($arr, $found[0] === 'after' ? $found[2] + 1 : $found[2], 0, [$widget]);
  unset($arr);
  return true;
}

function dpcfix_insert(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  $where = mb_substr((string) ($b['where'] ?? 'end'), 0, 200);
  $parts = array_slice((array) ($b['parts'] ?? []), 0, 40);
  if (!$id || !get_post($id) || !$fid || !$parts) return dpcfix_no('bad', 'Nothing to add.');
  $entry = ['fid' => $fid, 'at' => time(), 'where' => 'insert'];
  if (get_post_meta($id, '_elementor_edit_mode', true) === 'builder') {
    $raw = (string) get_post_meta($id, '_elementor_data', true);
    $data = json_decode($raw, true);
    if (!is_array($data)) return dpcfix_no('bad', "The page's Elementor content couldn't be read.");
    if (!dpcfix_insert_el($data, $where, dpcfix_parts_html($parts, false))) return dpcfix_no('not_found', 'That place was not found.');
    dpcfix_save_elementor($id, $data);
    $entry += ['kind' => 'el', 'before' => $raw, 'after_hash' => md5((string) get_post_meta($id, '_elementor_data', true))];
  } else {
    $content = (string) get_post($id)->post_content;
    $new = dpcfix_insert_content($content, $where, dpcfix_parts_html($parts, strpos($content, '<!-- wp:') !== false));
    if ($new === null) return dpcfix_no('not_found', 'That place was not found.');
    $r = dpcfix_save_content($id, $new);
    if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    $entry += ['kind' => 'content', 'before' => $content, 'after_hash' => md5(get_post($id)->post_content)];
  }
  if (!empty($b['faqs']) && is_array($b['faqs'])) {   // the FAQ schema, with the section
    $clean = [];
    foreach ($b['faqs'] as $x) {
      $q = trim(wp_strip_all_tags((string) ($x['q'] ?? '')));
      $a = trim(wp_strip_all_tags((string) ($x['a'] ?? '')));
      if ($q !== '' && $a !== '') $clean[] = ['q' => mb_substr($q, 0, 300), 'a' => mb_substr($a, 0, 1500)];
    }
    $old = get_post_meta($id, '_dpc_faq', true);
    $entry['faq_before'] = is_array($old) ? $old : [];
    if ($clean) update_post_meta($id, '_dpc_faq', wp_slash(array_slice($clean, 0, 20)));
  }
  dpcfix_log($id, $entry);
  dpcfix_purge($id);
  return ['ok' => true, 'link' => get_permalink($id)];
}

/* ---------- Internal links: turn words already on a page into a link ---------- */

// Is this position inside an open <tag>…</tag>? (tag can be a pattern, e.g. h[1-6])
function dpcfix_inside($src, $pos, $tag) {
  $before = substr($src, 0, $pos);
  $o = preg_match_all('/<' . $tag . '\b/i', $before, $m, PREG_OFFSET_CAPTURE) ? end($m[0])[1] + 1 : 0;
  $c = preg_match_all('/<\/' . $tag . '\s*>/i', $before, $m2, PREG_OFFSET_CAPTURE) ? end($m2[0])[1] + 1 : 0;
  return $o > $c;
}

function dpcfix_link(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  $find = trim((string) ($b['find'] ?? ''));
  $href = esc_url_raw((string) ($b['href'] ?? ''));
  if (!$id || !get_post($id) || !$fid || $find === '' || mb_strlen($find) > 120 || !$href) return dpcfix_no('bad', 'Nothing to link.');
  list($targets, $isEl, $data) = dpcfix_targets($id);
  $pick = null;
  foreach ($targets as $ti => $t) {
    $key = $t['path'] ? (string) $t['path'][count($t['path']) - 1] : '';
    if ($isEl && !preg_match('/(^|_)(editor|text|description|content)$/', $key)) continue;   // text blocks only: not headings or buttons
    foreach (dpcfix_hits($t['value'], dpcfix_needle($find)) as $h) {
      if ($h['tags'] || dpcfix_inside($t['value'], $h['a'], 'a') || dpcfix_inside($t['value'], $h['a'], 'h[1-6]')) continue;
      $pick = [$ti, $h];
      break 2;
    }
  }
  if (!$pick) return dpcfix_no('not_found', 'No place to link those words: they may already be a link, in a heading, or in a template.');
  list($ti, $h) = $pick;
  $v = $targets[$ti]['value'];
  $new = substr($v, 0, $h['a']) . '<a href="' . esc_url($href) . '">' . substr($v, $h['a'], $h['b'] - $h['a']) . '</a>' . substr($v, $h['b']);
  $entry = ['fid' => $fid, 'at' => time(), 'where' => $isEl ? 'elementor' : 'content', 'find' => $find, 'replace' => '(link)'];
  if ($isEl) {
    $ref = &dpcfix_ref($data, $targets[$ti]['path']); $ref = $new; unset($ref);
    dpcfix_save_elementor($id, $data);
    $entry['changes'] = [['path' => $targets[$ti]['path'], 'before' => $v, 'after' => $new]];
  } else {
    $r = dpcfix_save_content($id, $new);
    if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    $entry['before'] = $v;
    $entry['after_hash'] = md5(get_post($id)->post_content);
  }
  dpcfix_log($id, $entry);
  dpcfix_purge($id);
  return ['ok' => true, 'link' => get_permalink($id), 'context' => $h['ctx']];
}

/* ---------- Alt text: in the Media Library, and on the page's own image tags ---------- */

// "…/uploads/2024/05/cheek-laser-1024x683.webp?x=1" → "cheek-laser"
function dpcfix_stem($u) {
  $b = strtolower(basename(preg_replace('/[?#].*$/', '', (string) $u)));
  $b = preg_replace('/\.[a-z0-9]+$/', '', $b);
  return preg_replace('/(-\d+x\d+|-scaled)$/', '', $b);
}

// The image in the Media Library (sizes, "-scaled" and WebP copies tried too), or 0
function dpcfix_att_id($src) {
  $u = preg_replace('/[?#].*$/', '', (string) $src);
  $tries = [$u, preg_replace('/-\d+x\d+(\.[a-z0-9]+)$/i', '$1', $u), preg_replace('/-scaled(\.[a-z0-9]+)$/i', '$1', $u)];
  foreach ($tries as $t) {
    $aid = attachment_url_to_postid($t);
    if ($aid) return $aid;
    if (preg_match('/\.webp$/i', $t)) {
      foreach (['jpg', 'jpeg', 'png'] as $ext) {
        $aid = attachment_url_to_postid(preg_replace('/\.webp$/i', '.' . $ext, $t));
        if ($aid) return $aid;
      }
    }
  }
  return 0;
}

// <img> tags with no alt attribute whose file matches: alt added. $hits counts them by file.
function dpcfix_alt_html($html, $stems, &$hits) {
  return preg_replace_callback('/<img\b[^>]*>/i', function ($m) use ($stems, &$hits) {
    $tag = $m[0];
    if (preg_match('/\salt\s*=/i', $tag)) return $tag;
    if (!preg_match('/\s(?:data-src|data-lazy-src|src)\s*=\s*["\']([^"\']+)["\']/i', $tag, $s)) return $tag;
    $st = dpcfix_stem($s[1]);
    if (!array_key_exists($st, $stems)) return $tag;
    $hits[$st] = ($hits[$st] ?? 0) + 1;
    return preg_replace('/^<img\b/i', '<img alt="' . esc_attr($stems[$st]) . '"', $tag);
  }, $html);
}

function dpcfix_alt(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  $items = array_slice((array) ($b['items'] ?? []), 0, 20);
  if (!$id || !get_post($id) || !$fid || !$items) return dpcfix_no('bad', 'Nothing to save.');
  $stems = []; $metas = []; $out = []; $done = [];
  foreach ($items as $x) {
    $src = (string) ($x['src'] ?? '');
    if ($src === '') continue;
    $alt = mb_substr(trim(wp_strip_all_tags((string) ($x['alt'] ?? ''))), 0, 200);
    $aid = dpcfix_att_id($src);
    if ($aid && !isset($done[$aid])) {
      $done[$aid] = 1;
      $metas[] = ['aid' => $aid, 'before' => (string) get_post_meta($aid, '_wp_attachment_image_alt', true)];
      update_post_meta($aid, '_wp_attachment_image_alt', wp_slash($alt));
    }
    $stems[dpcfix_stem($src)] = $alt;
    $out[] = ['src' => $src, 'library' => $aid > 0, 'stem' => dpcfix_stem($src)];
  }
  list($targets, $isEl, $data) = dpcfix_targets($id);
  $changes = []; $hits = [];
  foreach ($targets as $t) {
    if (stripos($t['value'], '<img') === false) continue;
    $nv = dpcfix_alt_html($t['value'], $stems, $hits);
    if ($nv !== $t['value']) $changes[] = ['path' => $t['path'], 'before' => $t['value'], 'after' => $nv];
  }
  $entry = ['fid' => $fid, 'at' => time(), 'where' => 'alt', 'metas' => $metas, 'kind' => 'none'];
  if ($changes) {
    if ($isEl) {
      foreach ($changes as $c) { $ref = &dpcfix_ref($data, $c['path']); $ref = $c['after']; unset($ref); }
      dpcfix_save_elementor($id, $data);
      $entry['kind'] = 'el';
      $entry['changes'] = $changes;
    } else {
      $r = dpcfix_save_content($id, $changes[0]['after']);
      if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
      $entry['kind'] = 'content';
      $entry['before'] = $changes[0]['before'];
      $entry['after_hash'] = md5(get_post($id)->post_content);
    }
  }
  dpcfix_log($id, $entry);
  dpcfix_purge($id);
  foreach ($out as &$o) { $o['page'] = $hits[$o['stem']] ?? 0; unset($o['stem']); }
  unset($o);
  return ['ok' => true, 'items' => $out, 'link' => get_permalink($id)];
}

/* ---------- SEO title and meta description (All in One SEO, or Yoast) ---------- */

function dpcfix_seo_model($id) {
  if (!class_exists('\AIOSEO\Plugin\Common\Models\Post')) return null;
  $p = \AIOSEO\Plugin\Common\Models\Post::getPost($id);
  if (!$p) return null;
  if (method_exists($p, 'exists') && !$p->exists()) $p->post_id = $id;
  return $p;
}

function dpcfix_seo_get($id, $field) {
  $p = dpcfix_seo_model($id);
  if ($p) return ['aioseo', (string) ($field === 'title' ? $p->title : $p->description)];
  if (defined('WPSEO_VERSION')) return ['yoast', (string) get_post_meta($id, $field === 'title' ? '_yoast_wpseo_title' : '_yoast_wpseo_metadesc', true)];
  return [null, ''];
}

function dpcfix_seo_put($id, $field, $val) {
  $p = dpcfix_seo_model($id);
  if ($p) {
    if ($field === 'title') $p->title = $val; else $p->description = $val;
    $p->post_id = $id;
    $p->save();
    return 'aioseo';
  }
  if (defined('WPSEO_VERSION')) {
    update_post_meta($id, $field === 'title' ? '_yoast_wpseo_title' : '_yoast_wpseo_metadesc', wp_slash($val));
    return 'yoast';
  }
  return null;
}

function dpcfix_seo(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  $field = (string) ($b['field'] ?? '');
  $val = trim(sanitize_text_field((string) ($b['value'] ?? '')));
  if (!$id || !get_post($id) || !$fid || !in_array($field, ['title', 'description'], true) || $val === '' || mb_strlen($val) > 300) {
    return dpcfix_no('bad', 'Nothing to change.');
  }
  list($via, $before) = dpcfix_seo_get($id, $field);
  if (!$via) return dpcfix_no('no_seo', 'No SEO plugin found (All in One SEO or Yoast).');
  if ((string) $before === $val) return dpcfix_no('same', 'It already says that.');
  dpcfix_seo_put($id, $field, $val);
  dpcfix_log($id, ['fid' => $fid, 'at' => time(), 'where' => 'seo', 'field' => $field, 'before' => (string) $before, 'after' => $val]);
  dpcfix_purge($id);
  return ['ok' => true, 'via' => $via, 'before' => (string) $before, 'link' => get_permalink($id)];
}

/* ---------- Links: point them somewhere else, or remove them and keep the words ---------- */

// A link on this website → its path ("/laser-hair-removal"), or null for other websites, mailto: and the like
function dpcfix_nurl($u) {
  $u = trim(html_entity_decode((string) $u, ENT_QUOTES));
  if (preg_match('#^(?:https?:)?//([^/?\#]+)#i', $u, $m)) {
    $home = preg_replace('/^www\./i', '', strtolower((string) parse_url(home_url(), PHP_URL_HOST)));
    if (preg_replace('/^www\./i', '', strtolower($m[1])) !== $home) return null;
    $u = substr($u, strlen($m[0]));
  } elseif ($u === '' || $u[0] !== '/') {
    return null;
  }
  $u = rtrim(strtolower(preg_replace('/[?#].*$/', '', $u)), '/');
  return $u === '' ? '/' : $u;
}

// <a href="from">words</a> → <a href="to">words</a>, or just "words" when to is ''
function dpcfix_href_html($html, $map, &$n) {
  return preg_replace_callback('/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i', function ($m) use ($map, &$n) {
    if (!preg_match('/\shref\s*=\s*(["\'])(.*?)\1/i', $m[1], $h)) return $m[0];
    $k = dpcfix_nurl($h[2]);
    if ($k === null || !array_key_exists($k, $map)) return $m[0];
    $n[$k] = ($n[$k] ?? 0) + 1;
    if ($map[$k] === '') return $m[2];
    return '<a' . str_replace($h[0], ' href=' . $h[1] . esc_url($map[$k]) . $h[1], $m[1]) . '>' . $m[2] . '</a>';
  }, $html);
}

// Elementor: link settings ("url") and text that contains links
function dpcfix_href_el(&$node, $path, $map, &$n, &$changes, &$skip) {
  if (!is_array($node)) return;
  foreach ($node as $k => &$v) {
    $p = array_merge($path, [$k]);
    if (is_array($v)) { dpcfix_href_el($v, $p, $map, $n, $changes, $skip); continue; }
    if (!is_string($v) || $v === '') continue;
    if ($k === 'url') {
      $key = dpcfix_nurl($v);
      if ($key === null || !array_key_exists($key, $map)) continue;
      if ($map[$key] === '') { $skip[$key] = ($skip[$key] ?? 0) + 1; continue; }   // a button can't lose its link
      $changes[] = ['path' => $p, 'before' => $v, 'after' => $map[$key]];
      $v = $map[$key];
      $n[$key] = ($n[$key] ?? 0) + 1;
    } elseif (stripos($v, '<a') !== false) {
      $nv = dpcfix_href_html($v, $map, $n);
      if ($nv !== $v) { $changes[] = ['path' => $p, 'before' => $v, 'after' => $nv]; $v = $nv; }
    }
  }
  unset($v);
}

function dpcfix_href(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  if (!$id || !get_post($id) || !$fid) return dpcfix_no('bad', 'Nothing to change.');
  $map = [];
  foreach (array_slice((array) ($b['items'] ?? []), 0, 40) as $x) {
    $k = dpcfix_nurl($x['from'] ?? '');
    if ($k === null) continue;
    $to = trim((string) ($x['to'] ?? ''));
    $map[$k] = $to === '' ? '' : esc_url_raw($to);
  }
  if (!$map) return dpcfix_no('bad', 'No links to change.');
  $n = []; $skip = []; $changes = [];
  $entry = ['fid' => $fid, 'at' => time(), 'find' => '(links)', 'replace' => '(links)'];
  $raw = get_post_meta($id, '_elementor_data', true);
  $data = $raw ? json_decode((string) $raw, true) : null;
  if (is_array($data) && $data) {
    dpcfix_href_el($data, [], $map, $n, $changes, $skip);
    if ($changes) { dpcfix_save_elementor($id, $data); $entry['where'] = 'elementor'; $entry['changes'] = $changes; }
  } else {
    $p = get_post($id);
    $new = dpcfix_href_html($p->post_content, $map, $n);
    if ($new !== $p->post_content) {
      $r = dpcfix_save_content($id, $new);
      if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
      $entry['where'] = 'content';
      $entry['before'] = $p->post_content;
      $entry['after_hash'] = md5(get_post($id)->post_content);
    }
  }
  if (empty($entry['where'])) {
    return dpcfix_no('not_found', $skip ? 'These are buttons: change their link in Elementor.' : "These links aren't in the page's own content. They may be in the menu, footer or a template.");
  }
  dpcfix_log($id, $entry);
  dpcfix_purge($id);
  return ['ok' => true, 'counts' => $n, 'skipped' => $skip, 'link' => get_permalink($id)];
}

/* ---------- Main headings: extra H1s become H2s ---------- */

function dpcfix_h1_html($html, &$seen, $keep, $apply, &$texts) {
  return preg_replace_callback('/(<!--\s*wp:heading\s*(\{[^}]*\})?\s*-->\s*)?<h1\b([^>]*)>([\s\S]*?)<\/h1\s*>/i',
    function ($m) use (&$seen, $keep, $apply, &$texts) {
      $seen++;
      $texts[] = trim(wp_strip_all_tags($m[4]));
      if (!$apply || $seen <= $keep) return $m[0];
      $c = $m[1] !== '' ? preg_replace('/"level"\s*:\s*1\b/', '"level":2', $m[1]) : '';   // the block editor's note, so it stays valid
      return $c . '<h2' . $m[3] . '>' . $m[4] . '</h2>';
    }, $html);
}

// Elementor: Heading widgets set to H1, and text that contains <h1>. The theme's page title widget is left alone.
function dpcfix_h1_el(&$node, $path, &$seen, $keep, $apply, &$changes, &$texts) {
  if (!is_array($node)) return;
  if (($node['widgetType'] ?? '') === 'heading' && strtolower((string) ($node['settings']['header_size'] ?? '')) === 'h1') {
    $seen++;
    $texts[] = trim(wp_strip_all_tags((string) ($node['settings']['title'] ?? '')));
    if ($apply && $seen > $keep) {
      $changes[] = ['path' => array_merge($path, ['settings', 'header_size']), 'before' => $node['settings']['header_size'], 'after' => 'h2'];
      $node['settings']['header_size'] = 'h2';
    }
  }
  foreach ($node as $k => &$v) {
    $p = array_merge($path, [$k]);
    if (is_array($v)) { dpcfix_h1_el($v, $p, $seen, $keep, $apply, $changes, $texts); continue; }
    if (is_string($v) && stripos($v, '<h1') !== false) {
      $nv = dpcfix_h1_html($v, $seen, $keep, $apply, $texts);
      if ($apply && $nv !== $v) { $changes[] = ['path' => $p, 'before' => $v, 'after' => $nv]; $v = $nv; }
    }
  }
  unset($v);
}

// dry: count the H1s in the page's own content. Otherwise keep the first "keep" (0 or 1) and change the rest.
function dpcfix_h1(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0);
  $dry = !empty($b['dry']);
  $fid = preg_replace('/[^a-z0-9_-]/i', '', (string) ($b['fid'] ?? ''));
  $keep = max(0, min(1, (int) ($b['keep'] ?? 1)));
  if (!$id || !get_post($id) || (!$dry && !$fid)) return dpcfix_no('bad', 'Nothing to change.');
  $seen = 0; $changes = []; $texts = [];
  $raw = get_post_meta($id, '_elementor_data', true);
  $data = $raw ? json_decode((string) $raw, true) : null;
  $isEl = is_array($data) && $data;
  $p = get_post($id);
  $new = '';
  if ($isEl) dpcfix_h1_el($data, [], $seen, $keep, !$dry, $changes, $texts);
  else $new = dpcfix_h1_html($p->post_content, $seen, $keep, !$dry, $texts);
  if ($dry) return ['ok' => true, 'count' => $seen, 'texts' => array_slice($texts, 0, 12)];
  if ($seen <= $keep) return dpcfix_no('same', 'Nothing to change.');
  $entry = ['fid' => $fid, 'at' => time(), 'find' => '(h1)', 'replace' => '(h2)'];
  if ($isEl) {
    if (!$changes) return dpcfix_no('same', 'Nothing to change.');
    dpcfix_save_elementor($id, $data);
    $entry['where'] = 'elementor';
    $entry['changes'] = $changes;
  } else {
    if ($new === $p->post_content) return dpcfix_no('same', 'Nothing to change.');
    $r = dpcfix_save_content($id, $new);
    if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    $entry['where'] = 'content';
    $entry['before'] = $p->post_content;
    $entry['after_hash'] = md5(get_post($id)->post_content);
  }
  dpcfix_log($id, $entry);
  dpcfix_purge($id);
  return ['ok' => true, 'changed' => $seen - $keep, 'link' => get_permalink($id)];
}