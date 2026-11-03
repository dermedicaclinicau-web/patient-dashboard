<?php
/**
 * Plugin Name: Dermedica Portal Connector
 * Description: Lets the Dermedica staff portal read and update pages and blog posts (titles, SEO, status, redirects) with signed requests. No passwords are shared.
 * Version: 1.0.1
 * Author: Dermedica
 */
if (!defined('ABSPATH')) exit;

define('DPC_NS', 'dermedica-portal/v1');

function dpc_key() {
  $k = get_option('dpc_secret');
  if (!$k) { $k = wp_generate_password(64, false, false); update_option('dpc_secret', $k, false); }
  return $k;
}

/* ---------- Settings → Dermedica Portal ---------- */

add_action('admin_menu', function () {
  add_options_page('Dermedica Portal', 'Dermedica Portal', 'manage_options', 'dermedica-portal', 'dpc_settings_page');
});

function dpc_settings_page() {
  if (!current_user_can('manage_options')) return;
  if (isset($_POST['dpc_save']) && check_admin_referer('dpc_save')) {
    update_option('dpc_user', absint($_POST['dpc_user'] ?? 0), false);
    if (!empty($_POST['dpc_new_key'])) update_option('dpc_secret', wp_generate_password(64, false, false), false);
    echo '<div class="updated"><p>Saved.</p></div>';
  }
  $uid = (int) get_option('dpc_user');
  $users = get_users(['role__in' => ['administrator', 'editor'], 'orderby' => 'display_name']);
  ?>
  <div class="wrap">
    <h1>Dermedica Portal</h1>
    <p>Lets the staff portal manage pages and blog posts. Every request is signed with the key below.</p>
    <form method="post">
      <?php wp_nonce_field('dpc_save'); ?>
      <table class="form-table">
        <tr><th>Portal key</th><td>
          <input type="text" readonly class="large-text code" value="<?php echo esc_attr(dpc_key()); ?>" onclick="this.select()">
          <p class="description">Copy this into Apps Script → Project Settings → Script Properties as <code>WP_PORTAL_KEY</code>. Keep it private.</p>
          <label><input type="checkbox" name="dpc_new_key" value="1"> Make a new key (the old one stops working straight away)</label>
        </td></tr>
        <tr><th>Changes are made as</th><td>
          <select name="dpc_user"><option value="0">Choose…</option>
          <?php foreach ($users as $u) printf('<option value="%d"%s>%s (%s)</option>', $u->ID, selected($uid, $u->ID, false),
            esc_html($u->display_name), esc_html(implode(', ', $u->roles))); ?>
          </select>
          <p class="description">Revisions and history show this user. An Editor is enough.</p>
        </td></tr>
        <tr><th>Found on this site</th><td><?php
          echo 'Yoast SEO: ' . (defined('WPSEO_VERSION') ? 'on' : 'off') . '<br>';
          echo 'All in One SEO: ' . (function_exists('aioseo') ? 'on' : 'off') . '<br>';
          echo 'Elementor: ' . (defined('ELEMENTOR_VERSION') ? 'on' : 'off') . '<br>';
          echo 'Redirection: ' . (class_exists('Red_Item') ? 'on' : 'off');
        ?></td></tr>
      </table>
      <p><button class="button button-primary" name="dpc_save" value="1">Save</button></p>
    </form>
  </div>
  <?php
}

/* ---------- Checking each request ---------- */

function dpc_auth(WP_REST_Request $req) {
  $t = (string) $req->get_header('x-dpc-time');
  $sig = (string) $req->get_header('x-dpc-sig');
  if (!$t || !$sig || !ctype_digit($t) || abs(time() - (int) $t) > 300) {
    return new WP_Error('dpc_auth', 'The request has no signature, or the clocks differ by more than 5 minutes.', ['status' => 401]);
  }
  $path = '/' . trim($req->get_route(), '/');
  $want = hash_hmac('sha256', $t . "\n" . strtoupper($req->get_method()) . "\n" . $path . "\n" . hash('sha256', $req->get_body()), dpc_key());
  if (!hash_equals($want, $sig)) return new WP_Error('dpc_auth', 'The signature is wrong. Check WP_PORTAL_KEY.', ['status' => 401]);
  if ($req->get_method() !== 'GET') {   // a change can't be sent twice
    $seen = 'dpc_' . substr($sig, 0, 40);
    if (get_transient($seen)) return new WP_Error('dpc_auth', 'This request was already used.', ['status' => 401]);
    set_transient($seen, 1, 600);
  }
  $uid = (int) get_option('dpc_user');
  if (!$uid || !get_userdata($uid)) return new WP_Error('dpc_user', 'Choose the user in Settings → Dermedica Portal.', ['status' => 403]);
  wp_set_current_user($uid);
  return true;
}

add_action('rest_api_init', function () {
  $r = function ($route, $method, $cb) {
    register_rest_route(DPC_NS, $route, ['methods' => $method, 'callback' => $cb, 'permission_callback' => 'dpc_auth']);
  };
  $r('/ping', 'GET', 'dpc_ping');
  $r('/items', 'GET', 'dpc_items');
  $r('/items', 'POST', 'dpc_create');
  $r('/item/(?P<id>\d+)', 'GET', 'dpc_get');
  $r('/item/(?P<id>\d+)', 'POST', 'dpc_save');
  $r('/item/(?P<id>\d+)/trash', 'POST', 'dpc_trash');
  $r('/item/(?P<id>\d+)/restore', 'POST', 'dpc_restore');
  $r('/terms', 'GET', 'dpc_terms');
});

/* ---------- SEO fields: Yoast and All in One SEO ---------- */

function dpc_aioseo_post($id) {
  if (!function_exists('aioseo') || !class_exists('\\AIOSEO\\Plugin\\Common\\Models\\Post')) return null;
  try { return \AIOSEO\Plugin\Common\Models\Post::getPost($id); } catch (\Throwable $e) { return null; }
}
function dpc_kp($p) {
  $k = $p && isset($p->keyphrases) ? $p->keyphrases : null;
  if (is_string($k)) $k = json_decode($k, true);
  elseif (is_object($k)) $k = json_decode(wp_json_encode($k), true);
  return is_array($k) ? $k : [];
}

function dpc_plain($s) {
  return html_entity_decode((string) $s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

function dpc_seo_get($id) {
  $o = ['yoast' => null, 'aioseo' => null, 'live' => null];
  if (defined('WPSEO_VERSION')) {
    $o['yoast'] = [
      'title' => dpc_plain(get_post_meta($id, '_yoast_wpseo_title', true)),
      'description' => dpc_plain(get_post_meta($id, '_yoast_wpseo_metadesc', true)),
      'focus' => dpc_plain(get_post_meta($id, '_yoast_wpseo_focuskw', true)),
      'noindex' => get_post_meta($id, '_yoast_wpseo_meta-robots-noindex', true) === '1',
    ];
  }
  $a = dpc_aioseo_post($id);
  if ($a) {
    $k = dpc_kp($a);
    $o['aioseo'] = [
      'title' => dpc_plain($a->title ?? ''), 'description' => dpc_plain($a->description ?? ''),
      'focus' => isset($k['focus']['keyphrase']) ? dpc_plain($k['focus']['keyphrase']) : '',
      'noindex' => empty($a->robots_default) && !empty($a->robots_noindex),
    ];
    // What Google gets: the saved title, or All in One SEO's default when it's blank
    try {
      $p = get_post($id);
      $o['live'] = [
        'title' => dpc_plain(aioseo()->meta->title->getPostTitle($p)),
        'description' => dpc_plain(aioseo()->meta->description->getPostDescription($p)),
      ];
    } catch (\Throwable $e) { $o['live'] = null; }
  }
  return $o;
}

function dpc_seo_set($id, $s) {
  $has = function ($k) use ($s) { return array_key_exists($k, $s); };
  $txt = function ($k) use ($s) { return sanitize_text_field((string) $s[$k]); };
  if (defined('WPSEO_VERSION')) {
    if ($has('title')) update_post_meta($id, '_yoast_wpseo_title', $txt('title'));
    if ($has('description')) update_post_meta($id, '_yoast_wpseo_metadesc', $txt('description'));
    if ($has('focus')) update_post_meta($id, '_yoast_wpseo_focuskw', $txt('focus'));
    if ($has('noindex')) {
      if ($s['noindex']) update_post_meta($id, '_yoast_wpseo_meta-robots-noindex', '1');
      else delete_post_meta($id, '_yoast_wpseo_meta-robots-noindex');
    }
  }
  $a = dpc_aioseo_post($id);
  if ($a) {
    try {
      $a->post_id = $id;
      if ($has('title')) $a->title = $txt('title');
      if ($has('description')) $a->description = $txt('description');
      if ($has('focus')) {
        $k = dpc_kp($a);
        $k['focus'] = array_merge(isset($k['focus']) && is_array($k['focus']) ? $k['focus'] : [], ['keyphrase' => $txt('focus')]);
        if (!isset($k['additional'])) $k['additional'] = [];
        $a->keyphrases = wp_json_encode($k);
      }
      if ($has('noindex')) { $a->robots_default = $s['noindex'] ? 0 : 1; $a->robots_noindex = $s['noindex'] ? 1 : 0; }
      $a->save();
    } catch (\Throwable $e) { error_log('Dermedica Portal: All in One SEO not saved for ' . $id . ': ' . $e->getMessage()); }
  }
}

/* ---------- Pages and posts ---------- */

function dpc_out($p, $full = false) {
  $id = $p->ID;
  $link = get_permalink($id);
  $o = [
    'id' => $id, 'type' => $p->post_type, 'title' => $p->post_title, 'slug' => $p->post_name, 'status' => $p->post_status,
    'date' => $p->post_date, 'modified' => $p->post_modified, 'link' => $link, 'path' => wp_make_link_relative($link),
    'author' => get_the_author_meta('display_name', $p->post_author),
    'elementor' => get_post_meta($id, '_elementor_edit_mode', true) === 'builder',
    'featured' => (string) get_the_post_thumbnail_url($id, 'medium'), 'seo' => dpc_seo_get($id),
    'editUrl' => admin_url('post.php?post=' . $id . '&action=edit'),
  ];
  if ($o['elementor']) $o['elementorUrl'] = admin_url('post.php?post=' . $id . '&action=elementor');
  if ($full) {
    $o['excerpt'] = $p->post_excerpt;
    $o['content'] = $o['elementor'] ? null : $p->post_content;
    if ($p->post_type === 'post') {
      $o['categories'] = wp_get_post_categories($id);
      $o['tags'] = wp_get_post_tags($id, ['fields' => 'names']);
    }
  }
  return $o;
}

function dpc_ping() {
  $u = wp_get_current_user();
  return ['ok' => true, 'site' => get_bloginfo('name'), 'wp' => get_bloginfo('version'), 'user' => $u->display_name,
    'yoast' => defined('WPSEO_VERSION'), 'aioseo' => function_exists('aioseo'), 'elementor' => defined('ELEMENTOR_VERSION'),
    'redirection' => class_exists('Red_Item'), 'time' => time()];
}

function dpc_items(WP_REST_Request $r) {
  $type = in_array($r['type'], ['page', 'post'], true) ? $r['type'] : ['page', 'post'];
  $status = $r['status'] === 'trash' ? ['trash'] : ['publish', 'draft', 'pending', 'private', 'future'];
  $q = new WP_Query(['post_type' => $type, 'post_status' => $status, 'posts_per_page' => 800, 'orderby' => 'modified',
    'order' => 'DESC', 'no_found_rows' => true, 's' => sanitize_text_field((string) $r['search'])]);
  return ['ok' => true, 'items' => array_map('dpc_out', $q->posts)];
}

function dpc_post_or_error($id) {
  $p = get_post($id);
  if (!$p || !in_array($p->post_type, ['page', 'post'], true)) return new WP_Error('dpc_nf', 'Not found.', ['status' => 404]);
  if (!current_user_can('edit_post', $id)) return new WP_Error('dpc_cap', 'The portal user cannot edit this.', ['status' => 403]);
  return $p;
}

function dpc_get(WP_REST_Request $r) {
  $p = dpc_post_or_error((int) $r['id']);
  return is_wp_error($p) ? $p : ['ok' => true, 'item' => dpc_out($p, true)];
}

function dpc_save(WP_REST_Request $r) {
  $id = (int) $r['id'];
  $p = dpc_post_or_error($id);
  if (is_wp_error($p)) return $p;
  $b = (array) $r->get_json_params();
  $before = dpc_out($p, true);
  $u = ['ID' => $id];
  if (isset($b['title'])) $u['post_title'] = sanitize_text_field($b['title']);
  if (isset($b['slug'])) $u['post_name'] = sanitize_title($b['slug']);
  if (isset($b['excerpt'])) $u['post_excerpt'] = sanitize_textarea_field($b['excerpt']);
  if (isset($b['content'])) {
    if ($before['elementor']) return new WP_Error('dpc_elementor', 'This page is built with Elementor. Edit its content in Elementor.', ['status' => 409]);
    $u['post_content'] = wp_kses_post($b['content']);
  }
  if (isset($b['status'])) {
    $st = (string) $b['status'];
    if (!in_array($st, ['publish', 'draft', 'pending', 'private', 'future'], true)) return new WP_Error('dpc_bad', 'Unknown status.', ['status' => 400]);
    $u['post_status'] = $st;
    if ($st === 'future' && !empty($b['date'])) {
      $u['post_date'] = sanitize_text_field($b['date']);
      $u['post_date_gmt'] = get_gmt_from_date($u['post_date']);
      $u['edit_date'] = true;
    }
  }
  if ($p->post_type === 'post') {
    if (isset($b['categories'])) $u['post_category'] = array_map('absint', (array) $b['categories']);
    if (isset($b['tags'])) $u['tags_input'] = array_map('sanitize_text_field', (array) $b['tags']);
  }
  if (isset($b['seo'])) dpc_seo_set($id, (array) $b['seo']);
  $res = wp_update_post(wp_slash($u), true);   // always run: it also refreshes Yoast's copy of the SEO fields
  if (is_wp_error($res)) return $res;
  if (isset($b['featured'])) { $f = absint($b['featured']); if ($f) set_post_thumbnail($id, $f); else delete_post_thumbnail($id); }
  clean_post_cache($id);
  $after = dpc_out(get_post($id), true);
  $redirect = null;
  if (!empty($b['redirectOld']) && $before['status'] === 'publish' && $before['path'] !== $after['path']) {
    $redirect = dpc_redirect($before['path'], $after['path']);
  }
  return ['ok' => true, 'before' => $before, 'item' => $after, 'redirect' => $redirect];
}

function dpc_create(WP_REST_Request $r) {
  $b = (array) $r->get_json_params();
  $type = ($b['type'] ?? 'post') === 'page' ? 'page' : 'post';
  $st = in_array($b['status'] ?? 'draft', ['draft', 'pending'], true) ? $b['status'] : 'draft';
  $id = wp_insert_post(wp_slash([
    'post_type' => $type, 'post_status' => $st, 'post_title' => sanitize_text_field($b['title'] ?? 'Untitled'),
    'post_name' => sanitize_title($b['slug'] ?? ''), 'post_content' => wp_kses_post($b['content'] ?? ''),
    'post_excerpt' => sanitize_textarea_field($b['excerpt'] ?? ''),
  ]), true);
  if (is_wp_error($id)) return $id;
  if (!empty($b['seo'])) { dpc_seo_set($id, (array) $b['seo']); wp_update_post(['ID' => $id]); }
  return ['ok' => true, 'item' => dpc_out(get_post($id), true)];
}

function dpc_trash(WP_REST_Request $r) {
  $id = (int) $r['id'];
  $p = dpc_post_or_error($id);
  if (is_wp_error($p)) return $p;
  $b = (array) $r->get_json_params();
  $before = dpc_out($p);
  if (!wp_trash_post($id)) return new WP_Error('dpc_trash', 'It could not be moved to the bin.', ['status' => 500]);
  $redirect = !empty($b['redirectTo']) ? dpc_redirect($before['path'], (string) $b['redirectTo']) : null;
  return ['ok' => true, 'before' => $before, 'redirect' => $redirect];
}

function dpc_restore(WP_REST_Request $r) {
  $id = (int) $r['id'];
  $p = get_post($id);
  if (!$p || $p->post_status !== 'trash') return new WP_Error('dpc_nf', 'It is not in the bin.', ['status' => 404]);
  if (!current_user_can('delete_post', $id)) return new WP_Error('dpc_cap', 'The portal user cannot restore this.', ['status' => 403]);
  wp_untrash_post($id);   // comes back as a draft
  return ['ok' => true, 'item' => dpc_out(get_post($id), true)];
}

function dpc_terms() {
  return ['ok' => true, 'categories' => array_map(function ($t) { return ['id' => $t->term_id, 'name' => $t->name]; },
    get_categories(['hide_empty' => false]))];
}

/* ---------- Redirects (the Redirection plugin) ---------- */

function dpc_redirect($from, $to) {
  if (!class_exists('Red_Item')) return ['ok' => false, 'why' => 'The Redirection plugin is not on.'];
  global $wpdb;
  $gid = (int) $wpdb->get_var("SELECT id FROM {$wpdb->prefix}redirection_groups WHERE status = 'enabled' ORDER BY id ASC LIMIT 1");
  if (!$gid) return ['ok' => false, 'why' => 'Redirection has no group.'];
  $res = Red_Item::create(['url' => $from, 'action_data' => ['url' => $to], 'action_type' => 'url',
    'action_code' => 301, 'match_type' => 'url', 'group_id' => $gid]);
  return is_wp_error($res) ? ['ok' => false, 'why' => $res->get_error_message()] : ['ok' => true, 'from' => $from, 'to' => $to];
}