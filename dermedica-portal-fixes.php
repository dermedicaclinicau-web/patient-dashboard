<?php
/**
 * Plugin Name: Dermedica Portal Fixes
 * Description: Lets the staff portal fix a word or phrase on a page (spelling, grammar, wording) and undo it. Works alongside Dermedica Portal Connector.
 * Version: 1.3.0
 */
if (!defined('ABSPATH')) exit;

const DPCFIX_NS = 'dermedica-portal/v1';
const DPCFIX_LOG = '_dpc_fix_log';
// Does this Elementor setting hold words people read? Judged by the last part of its name ("link_text" yes, "title_size" no),
// so text fields whose names contain "link", "view" or "size" somewhere aren't missed.
function dpcfix_is_text($k, $v) {
  if (!is_string($k) || $k === '' || $k[0] === '_') return false;
  $base = preg_replace('/_(tablet|mobile|mobile_extra|tablet_extra|laptop|widescreen|hover|active)$/', '', strtolower($k));
  $parts = explode('_', $base);
  $last = end($parts);
  if (preg_match('/^(id|url|link|href|image|img|icon|icons|svg|css|class|classes|color|colour|font|family|weight|size|width|height|align|alignment|position|animation|motion|background|bg|border|radius|padding|margin|gap|spacing|style|tag|type|layout|view|selected|source|anchor|lightbox|video|embed|shortcode|template|target|rel|nofollow|ratio|duration|delay|direction|effect|transition|shadow|opacity|blend|display|overflow|unit|units|key|slug|lang)$/', $last)) return false;
  if (preg_match('/^[a-z0-9_#.%-]+$/', $v)) return false;   // a single setting word: center, h2, solid, yes, #fff
  return (bool) preg_match('/\p{L}{2}/u', $v);
}

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
    "\u{2013}" => '-', "\u{2014}" => '-', "\u{00A0}" => ' ', "\u{2010}" => '-', "\u{2011}" => '-', "\u{2012}" => '-', "\u{2212}" => '-'];
  // Invisible: soft hyphens and zero-width characters don't count at all
  static $drop = ["\u{00AD}" => 1, "\u{200B}" => 1, "\u{200C}" => 1, "\u{200D}" => 1, "\u{2060}" => 1, "\u{FEFF}" => 1];
  if (isset($drop[$ch])) return '';
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
      if ($f === '') continue;   // invisible
      $c = mb_strtolower($f, 'UTF-8');
      if ($c === ' ' && (!$chars || end($chars) === ' ')) continue;
      $chars[] = $c; $orig[] = $f; $st[] = $off; $en[] = $end;
    }
  }
  return [implode('', $chars), $st, $en, $orig];
}

// Tokens for the diff: whole words (letters and digits), or one other character. Each: [first char, length, key]
function dpcfix_toks($chars, $keepCase) {
  $out = []; $n = count($chars); $i = 0;
  while ($i < $n) {
    $j = $i + 1;
    if (preg_match('/^[\p{L}\p{N}]$/u', $chars[$i])) {
      while ($j < $n && preg_match('/^[\p{L}\p{N}]$/u', $chars[$j])) $j++;
    }
    $k = implode('', array_slice($chars, $i, $j - $i));
    $out[] = [$i, $j - $i, $keepCase ? mb_strtolower($k, 'UTF-8') : $k];
    $i = $j;
  }
  return $out;
}

// The parts that differ, in order: [[a0, a1, b0, b1], …] token ranges (page a, new wording b)
function dpcfix_diff($A, $B) {
  $n = count($A); $m = count($B);
  $p = 0; while ($p < $n && $p < $m && $A[$p][2] === $B[$p][2]) $p++;
  $s = 0; while ($s < $n - $p && $s < $m - $p && $A[$n - 1 - $s][2] === $B[$m - 1 - $s][2]) $s++;
  $a = array_slice($A, $p, $n - $p - $s); $b = array_slice($B, $p, $m - $p - $s);
  $N = count($a); $M = count($b);
  if (!$N && !$M) return [];
  if (!$N || !$M || $N * $M > 250000) return [[$p, $n - $s, $p, $m - $s]];
  $L = array_fill(0, $N + 1, array_fill(0, $M + 1, 0));   // longest common run, from the end
  for ($i = $N - 1; $i >= 0; $i--) for ($j = $M - 1; $j >= 0; $j--) {
    $L[$i][$j] = $a[$i][2] === $b[$j][2] ? $L[$i + 1][$j + 1] + 1 : max($L[$i + 1][$j], $L[$i][$j + 1]);
  }
  $hunks = []; $h = null; $i = 0; $j = 0;
  while ($i < $N || $j < $M) {
    if ($i < $N && $j < $M && $a[$i][2] === $b[$j][2]) {
      if ($h) { $hunks[] = $h; $h = null; }
      $i++; $j++; continue;
    }
    if (!$h) $h = [$p + $i, $p + $i, $p + $j, $p + $j];
    if ($j < $M && ($i >= $N || $L[$i][$j + 1] >= $L[$i + 1][$j])) { $j++; $h[3] = $p + $j; }
    else { $i++; $h[1] = $p + $i; }
  }
  if ($h) $hunks[] = $h;
  return $hunks;
}

// The change as small separate edits: each changed piece is replaced where it sits, so bold, links, table cells and
// paragraph breaks between the pieces stay as they are. keepCase (spelling): capitals on the page stay.
// The first letter of a paragraph, cell or line keeps its capital. Returns [[start, end, new HTML], …], or null.
function dpcfix_edit($src, $st, $en, $orig, $at, $n, $rep, $keepCase) {
  $rc = array_values(array_filter(preg_split('//u', $rep, -1, PREG_SPLIT_NO_EMPTY),
    function ($ch) { return dpcfix_fold_char($ch) !== ''; }));
  $rf = array_map('dpcfix_fold_char', $rc);
  $pc = array_slice($orig, $at, $n);
  $total = count($orig);
  $len = strlen($src);
  // A space that's really a tag (a paragraph, cell or line break)
  $virt = function ($i) use ($src, $st, $orig) { return $orig[$i] === ' ' && substr($src, $st[$i], 1) === '<'; };
  $same = function ($i, $y) use ($orig, $keepCase, $virt) {
    $x = $orig[$i];
    if ($x === $y) return true;
    $lx = mb_strtolower($x, 'UTF-8');
    if ($keepCase && $lx === mb_strtolower($y, 'UTF-8')) return true;
    return $lx === $y && ($i === 0 || $virt($i - 1));   // a capital at the start of a block stays
  };
  $A = dpcfix_toks($pc, $keepCase); $B = dpcfix_toks($rf, $keepCase);
  $cA = function ($k) use ($A, $n) { return $k < count($A) ? $A[$k][0] : $n; };
  $cB = function ($k) use ($B, $rf) { return $k < count($B) ? $B[$k][0] : count($rf); };
  $edits = [];
  foreach (dpcfix_diff($A, $B) as $h) {
    $i0 = $cA($h[0]); $i1 = $cA($h[1]); $j0 = $cB($h[2]); $j1 = $cB($h[3]);
    while ($i0 < $i1 && $j0 < $j1 && $same($at + $i0, $rf[$j0])) { $i0++; $j0++; }
    while ($i1 > $i0 && $j1 > $j0 && $same($at + $i1 - 1, $rf[$j1 - 1])) { $i1--; $j1--; }
    if ($i0 === $i1 && $j0 === $j1) continue;
    $txt = htmlspecialchars(implode('', array_slice($rc, $j0, $j1 - $j0)), ENT_NOQUOTES, 'UTF-8');
    $real = [];
    for ($k = $at + $i0; $k < $at + $i1; $k++) if (!$virt($k)) $real[] = $k;
    if (!$real) {   // only adding words (a break that would "change" stays where it is)
      if ($txt === '') continue;
      $p = $at + $i0;
      $pos = $p > $at ? $en[$p - 1] : $st[$p];
      $edits[] = [$pos, $pos, $txt];
      continue;
    }
    $first = true; $seen = [];
    foreach ($real as $k) {
      if (isset($seen[$st[$k]])) continue;
      // Part of one &entity; changing on its own: leave it to WordPress
      if (($k > 0 && $st[$k - 1] === $st[$k] && $k - 1 < $at + $i0) ||
          ($k + 1 < $total && $st[$k + 1] === $st[$k] && $k + 1 >= $at + $i1)) return null;
      $seen[$st[$k]] = 1;
      $b = $en[$k];
      if ($orig[$k] === ' ') while ($b < $len && strpos(" \t\r\n", $src[$b]) !== false) $b++;   // the extra spaces in the HTML too
      $edits[] = [$st[$k], $b, $first ? $txt : ''];
      $first = false;
    }
  }
  return $edits;
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
    elseif ($inSettings && is_string($v) && dpcfix_is_text($k, $v)) {
      $out[] = ['path' => $p, 'value' => $v];
    }
  }
}

function dpcfix_all_hits($targets, $needle) {
  $hits = [];
  foreach ($targets as $i => $t) foreach (dpcfix_hits($t['value'], $needle) as $h) { $h['t'] = $i; $hits[] = $h; }
  return $hits;
}

// The portal reads a space where a link or bold text ends ("pigmentation , thin"). The exact words are tried first,
// so a real stray space can still be fixed; if they aren't found, they're tried without a space before punctuation.
function dpcfix_find_hits($targets, $find) {
  $needle = dpcfix_needle($find);
  $hits = dpcfix_all_hits($targets, $needle);
  if ($hits) return $hits;
  $loose = preg_replace('/\s+([,.;:!?)\]])/u', '$1', $needle);
  return $loose !== $needle ? dpcfix_all_hits($targets, $loose) : [];
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

/* ---------- When the words aren't in the page itself ---------- */

// Does this content point to the template or block? Any setting with "templ" in its name (Elementor's global widgets
// and template widget, and add-ons like Essential Addons, JetElements and ElementsKit), the shortcode, or a reusable block.
function dpcfix_refers($raw, $tid) {
  $t = (int) $tid;
  return (bool) preg_match('/"[a-z0-9_]*templ[a-z0-9_]*"\s*:\s*"?' . $t . '(?![0-9])|template[^\]]{0,20}?id=\\\\?["\']?' . $t . '(?![0-9])|"ref":' . $t . '(?![0-9])/i', (string) $raw);
}

// How many other published pages show this template or block (drafts and revisions don't count)
function dpcfix_uses($tid, $not) {
  global $wpdb;
  $t = (int) $tid;
  $like = '%' . $t . '%';
  $rows = array_merge(
    $wpdb->get_results($wpdb->prepare("SELECT post_id AS id, meta_value AS v FROM {$wpdb->postmeta} WHERE meta_key = '_elementor_data' AND meta_value LIKE %s LIMIT 300", $like)),
    $wpdb->get_results($wpdb->prepare("SELECT ID AS id, post_content AS v FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_content LIKE %s LIMIT 300", $like))
  );
  $seen = [];
  foreach ($rows as $r) {
    $pid = (int) $r->id;
    if ($pid === $t || $pid === (int) $not || isset($seen[$pid])) continue;
    $p = get_post($pid);
    if (!$p || ($p->post_status !== 'publish' && $p->post_type !== 'elementor_library')) continue;
    if (dpcfix_refers($r->v, $t)) $seen[$pid] = 1;
  }
  return count($seen);
}

// Elementor Theme Builder display conditions: 'only' (just this page), 'wide' (other pages too), or 'none'
function dpcfix_conditions($tid, $id) {
  $c = get_post_meta($tid, '_elementor_conditions', true);
  if (!is_array($c) || !$c) return 'none';
  $inc = array_values(array_filter($c, function ($x) { return strpos((string) $x, 'include/') === 0; }));
  if (!$inc) return 'none';
  foreach ($inc as $x) {
    if (!preg_match('#^include/singular/[a-z0-9_-]+/(\d+)$#', (string) $x, $m) || (int) $m[1] !== (int) $id) return 'wide';
  }
  return 'only';
}

// Every other place the words are: the page's custom fields and excerpt, the templates and blocks it shows,
// and any Elementor template or reusable block containing them (Theme Builder templates apply by their conditions).
// Each: { src: { post, mode, key, label, shared, uses, editUrl }, targets, data, hits }
function dpcfix_elsewhere($id, $find) {
  global $wpdb;
  $out = [];
  $p = get_post($id);
  if (!$p) return $out;
  $try = function ($src, $targets, $data) use (&$out, $find) {
    $hits = dpcfix_find_hits($targets, $find);
    if ($hits) $out[] = ['src' => $src, 'targets' => $targets, 'data' => $data, 'hits' => $hits];
  };

  // 1. The page's own excerpt and custom fields (ACF and the like)
  if (trim((string) $p->post_excerpt) !== '') {
    $try(['post' => $id, 'mode' => 'excerpt', 'label' => 'the page excerpt', 'shared' => false],
      [['path' => [], 'value' => (string) $p->post_excerpt]], null);
  }
  foreach (get_post_meta($id) as $k => $vals) {
    if ($k === '' || $k[0] === '_' || count($vals) !== 1) continue;
    $v = maybe_unserialize($vals[0]);
    if (!is_string($v) || strlen($v) > 200000 || !preg_match('/\p{L}{2}/u', $v)) continue;
    $try(['post' => $id, 'mode' => 'meta', 'key' => $k, 'label' => 'the custom field “' . $k . '”', 'shared' => false],
      [['path' => [], 'value' => $v]], null);
  }

  // 2. Templates and blocks: the ones this page shows (1), and any containing the words (2)
  $refs = [];
  $raw = (string) get_post_meta($id, '_elementor_data', true) . ' ' . $p->post_content;
  if (preg_match_all('/"[a-z0-9_]*templ[a-z0-9_]*"\s*:\s*"?(\d+)|template[^\]]{0,20}?id=\\\\?["\']?(\d+)|"ref":(\d+)/i', $raw, $m, PREG_SET_ORDER)) {
    foreach ($m as $x) {
      $n = (int) (!empty($x[1]) ? $x[1] : (!empty($x[2]) ? $x[2] : ($x[3] ?? 0)));
      if ($n) $refs[$n] = 1;
    }
  }
  $words = preg_split('/[^\p{L}\p{N}]+/u', dpcfix_needle($find), -1, PREG_SPLIT_NO_EMPTY);
  usort($words, function ($a, $b) { return mb_strlen($b) - mb_strlen($a); });
  $w = $words[0] ?? '';
  if (mb_strlen($w) >= 5) {
    $like = '%' . $wpdb->esc_like($w) . '%';
    $ids = $wpdb->get_col($wpdb->prepare(
      "SELECT DISTINCT p.ID FROM {$wpdb->posts} p LEFT JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = '_elementor_data'
       WHERE p.post_type IN ('elementor_library', 'wp_block') AND p.post_status = 'publish' AND (p.post_content LIKE %s OR m.meta_value LIKE %s) LIMIT 20",
      $like, $like));
    foreach ($ids as $n) { $n = (int) $n; if (!isset($refs[$n])) $refs[$n] = 2; }
  }
  foreach ($refs as $tid => $how) {
    if ($tid === $id) continue;
    $tp = get_post($tid);
    if (!$tp) continue;
    list($t, $isEl, $data) = dpcfix_targets($tid);
    $hits = dpcfix_find_hits($t, $find);
    if (!$hits) continue;
    $uses = dpcfix_uses($tid, $id);
    $cond = dpcfix_conditions($tid, $id);
    $kind = $tp->post_type === 'wp_block' ? 'reusable block' : 'Elementor template';
    // This page's own: no other page shows it, its conditions don't reach further, and this page points to it or is its only condition
    $only = $uses === 0 && $cond !== 'wide' && ($how === 1 || $cond === 'only');
    $out[] = ['src' => [
      'post' => $tid, 'mode' => $isEl ? 'elementor' : 'content', 'uses' => $uses, 'cond' => $cond, 'linked' => $how === 1,
      'label' => 'the ' . $kind . ' “' . $tp->post_title . '”',
      'shared' => !$only,
      'editUrl' => $isEl ? admin_url('post.php?post=' . $tid . '&action=elementor') : (string) get_edit_post_link($tid, 'raw'),
    ], 'targets' => $t, 'data' => $data, 'hits' => $hits];
  }
  return $out;
}
/* ---------- The routes ---------- */

// Looks only: how many times the words appear, and where. Changes nothing.
function dpcfix_find(WP_REST_Request $req) {
  $b = $req->get_json_params() ?: [];
  $id = (int) ($b['id'] ?? 0); $find = trim((string) ($b['find'] ?? ''));
  if (!$id || !get_post($id) || $find === '') return dpcfix_no('bad', 'Nothing to look for.');
  list($targets, $isEl) = dpcfix_targets($id);
  $hits = dpcfix_find_hits($targets, $find);
  $out = ['ok' => true, 'elementor' => $isEl, 'count' => count($hits), 'hits' => array_map(function ($h) {
    return ['formatted' => $h['tags'], 'context' => $h['ctx'], 'match' => $h['match']];
  }, array_slice($hits, 0, 20))];
  if (!$hits) {
    $out['elsewhere'] = array_map(function ($f) {
      return ['in' => $f['src']['label'], 'post' => $f['src']['post'], 'shared' => $f['src']['shared'],
        'uses' => $f['src']['uses'] ?? null, 'cond' => $f['src']['cond'] ?? '', 'linked' => !empty($f['src']['linked']),
        'count' => count($f['hits'])];
    }, dpcfix_elsewhere($id, $find));
    // Where the longest word sits in the page's Elementor data, and whether that field is read as text
    $raw = [];
    $data = json_decode((string) get_post_meta($id, '_elementor_data', true), true);
    $words = preg_split('/[^\p{L}\p{N}]+/u', dpcfix_needle($find), -1, PREG_SPLIT_NO_EMPTY);
    usort($words, function ($a, $b) { return mb_strlen($b) - mb_strlen($a); });
    $w = $words[0] ?? '';
    if (is_array($data) && $w !== '') {
      $scan = function ($node, $path) use (&$scan, &$raw, $w) {
        foreach ($node as $k => $v) {
          if (is_array($v)) { $scan($v, array_merge($path, [$k])); continue; }
          if (is_string($v) && count($raw) < 10 && mb_stripos($v, $w) !== false) {
            $raw[] = ['key' => implode('.', array_merge($path, [$k])), 'read' => dpcfix_is_text((string) $k, $v),
              'text' => mb_substr(trim(wp_strip_all_tags($v)), 0, 200)];
          }
        }
      };
      $scan($data, []);
    }
    $out['inPageData'] = $raw;
    $out['template'] = get_post_meta($id, '_wp_page_template', true);
  }
  $out['v'] = '1.3.0';
  return $out;
}

// Changes the words. Exactly one place, unless "all" (spelling: every place the misspelt word appears).
// Only the characters that differ are replaced, so formatting around them stays.
// Not in the page itself: its custom field, excerpt, or a template or block only this page shows is changed instead.
// A template or block other pages show too is named, not changed (unless "shared" is sent).
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
  $src = ['post' => $id, 'mode' => $isEl ? 'elementor' : 'content', 'label' => '', 'shared' => false];
  $hits = dpcfix_find_hits($targets, $find);
  if (!$hits) {
    $found = dpcfix_elsewhere($id, $find);
    if (!$found) return dpcfix_no('not_found', 'Not found in the page.');
    if (count($found) > 1) {
      return dpcfix_no('many_places', 'Found in more than one place.', ['places' => array_map(function ($f) { return $f['src']['label']; }, $found)]);
    }
    $f = $found[0];
    if ($f['src']['shared'] && empty($b['shared'])) {
      return dpcfix_no('shared', 'In a shared template.', ['label' => $f['src']['label'], 'uses' => $f['src']['uses'] ?? 0,
        'cond' => $f['src']['cond'] ?? '', 'editUrl' => $f['src']['editUrl'] ?? '']);
    }
    $src = $f['src']; $targets = $f['targets']; $data = $f['data']; $hits = $f['hits'];
  }
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
      if (!is_array($e)) return dpcfix_no('formatted', 'Formatting inside the part that changes.', ['context' => $h['ctx']]);
      $edits = array_merge($edits, $e);
    }
    usort($edits, function ($x, $y) { return ($y[0] - $x[0]) ?: ($y[1] - $x[1]); });   // from the end, so earlier positions stay right
    foreach ($edits as $e) $v = substr_replace($v, $e[2], $e[0], $e[1] - $e[0]);
    // A link left with no words would vanish from the page: stop instead
    $emptyA = '/<a\b[^>]*>\s*<\/a\s*>/i';
    if (preg_match_all($emptyA, $v) > preg_match_all($emptyA, $targets[$ti]['value'])) {
      return dpcfix_no('link', 'The change would remove the words of a link.', ['context' => $hs[0]['ctx']]);
    }
    // Bold or italics left with nothing inside: tidied away
    $emptyI = '/<(strong|b|em|i|u|span)\b[^>]*>\s*<\/\1\s*>/i';
    if (!preg_match($emptyI, $targets[$ti]['value'])) $v = preg_replace($emptyI, '', $v);
    if ($v !== $targets[$ti]['value']) $changes[] = ['path' => $targets[$ti]['path'], 'before' => $targets[$ti]['value'], 'after' => $v];
  }
  if (!$changes) return dpcfix_no('same', 'The new wording is the same as what the page says.');

  $pid = (int) $src['post'];
  $entry = ['fid' => $fid, 'at' => time(), 'find' => $find, 'replace' => $rep, 'page' => $id];
  if ($src['mode'] === 'elementor') {
    foreach ($changes as $c) { $ref = &dpcfix_ref($data, $c['path']); $ref = $c['after']; unset($ref); }
    dpcfix_save_elementor($pid, $data);
    $entry['where'] = 'elementor';
    $entry['changes'] = $changes;
  } elseif ($src['mode'] === 'meta') {
    update_post_meta($pid, $src['key'], wp_slash($changes[0]['after']));
    $entry += ['where' => 'meta', 'key' => $src['key'], 'before' => $changes[0]['before'], 'after' => $changes[0]['after']];
  } elseif ($src['mode'] === 'excerpt') {
    kses_remove_filters();
    $r = wp_update_post(['ID' => $pid, 'post_excerpt' => wp_slash($changes[0]['after'])], true);
    kses_init();
    if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    $entry += ['where' => 'excerpt', 'before' => $changes[0]['before'], 'after' => (string) get_post($pid)->post_excerpt];
  } else {
    $r = dpcfix_save_content($pid, $changes[0]['after']);
    if (is_wp_error($r)) return dpcfix_no('save', $r->get_error_message());
    $entry += ['where' => 'content', 'before' => $changes[0]['before'], 'after_hash' => md5(get_post($pid)->post_content)];
  }
  dpcfix_log($pid, $entry);
  dpcfix_purge($pid);
  if ($pid !== $id) dpcfix_purge($id);   // the page showing the template
  return ['ok' => true, 'where' => $entry['where'], 'post' => $pid, 'in' => $src['label'], 'wide' => !empty($src['shared']),
    'uses' => $src['uses'] ?? 0, 'count' => count($hits),
    'link' => get_permalink($id), 'context' => $hits[0]['ctx']];
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
    } elseif ($e['where'] === 'meta') {
      if ((string) get_post_meta($id, $e['key'], true) !== (string) $e['after']) return dpcfix_no('changed', 'Edited since.');
      update_post_meta($id, $e['key'], wp_slash((string) $e['before']));
    } elseif ($e['where'] === 'excerpt') {
      $p = get_post($id);
      if (!$p || (string) $p->post_excerpt !== (string) $e['after']) return dpcfix_no('changed', 'Edited since.');
      kses_remove_filters(); wp_update_post(['ID' => $id, 'post_excerpt' => wp_slash((string) $e['before'])]); kses_init();
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
    if (!empty($e['page']) && (int) $e['page'] !== $id) dpcfix_purge((int) $e['page']);
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