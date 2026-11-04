<?php require __DIR__ . '/../lib/components/kit.php'; ?>
<main>
  <button type="button">Raw</button>
  <div class="modal-overlay"></div>
  <span class="status-badge">Live</span>
  <a class="kit-btn" href="/go">Go</a>
  <p style="color: #000">Ink</p>
  <span class="glyphs-outlined" style="font-size:14px">close</span>
  <?= kit_badge('Old', ['variant' => 'shiny']) ?>
</main>
