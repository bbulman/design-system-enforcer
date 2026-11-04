<?php require __DIR__ . '/../lib/components/kit.php'; ?>
<main>
  <?= kit_section_header('Welcome', ['subtitle' => 'Everything in one place']) ?>
  <?= kit_card(kit_badge('New') . ' A made-up home page.') ?>
  <?= kit_button('Start', ['variant' => 'primary']) ?>
</main>
