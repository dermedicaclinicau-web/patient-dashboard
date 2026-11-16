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
  foreach (['find' => 'dpcfix_find', 'replace' => 'dpcfix_replace', 'undo' => 'dpcfix_undo'] as $r => $cb) {
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

// Each place the words appear (whole words only): byte range, whether formatting is inside it, and the text around it
function dpcfix_hits($src, $needle) {
  if ($needle === '' || !is_string($src) || $src === '') return [];
  list($plain, $st, $en) = dpcfix_index($src);
  $out = []; $from = 0; $n = mb_strlen($needle, 'UTF-8');
  $word = '/[\p{L}\p{N}]/u';
  $edgeL = preg_match($word, mb_substr($needle, 0, 1, 'UTF-8'));
  $edgeR = preg_match($word, mb_substr($needle, -1, 1, 'UTF-8'));
  while (($at = mb_strpos($plain, $needle, $from, 'UTF-8')) !== false) {
    $from = $at + 1;
    if ($edgeL && $at > 0 && preg_match($word, mb_substr($plain, $at - 1, 1, 'UTF-8'))) continue;
    if ($edgeR && preg_match($word, mb_substr($plain, $at + $n, 1, 'UTF-8'))) continue;
    $a = $st[$at]; $b = $en[$at + $n - 1];
    $out[] = ['a' => $a, 'b' => $b, 'at' => $at, 'n' => $n, 'tags' => strpos(substr($src, $a, $b - $a), '<') !== false,
      'ctx' => mb_substr($plain, max(0, $at - 60), $n + 120, 'UTF-8')];
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
    return ['formatted' => $h['tags'], 'context' => $h['ctx']];
  }, array_slice($hits, 0, 5))];
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
  $post = $id ? get_post($id) : null;
  if (!$post) return dpcfix_no('not_found', "That page isn't in WordPress.");
  if ($find === '' || $rep === '' || mb_strlen($find) > 200 || mb_strlen($rep) > 400 || !$fid) return dpcfix_no('bad', 'Nothing to change.');

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
    if ($e['where'] === 'elementor') {
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