<?php /* kit_button: an <a> with href, else a <button>. */ ?>
<?php if (!empty($options['href'])): ?>
<a class="kit-btn kit-btn--<?= htmlspecialchars($options['variant'] ?? 'primary') ?>" href="<?= htmlspecialchars($options['href']) ?>"><?= htmlspecialchars($text) ?></a>
<?php else: ?>
<button class="kit-btn kit-btn--<?= htmlspecialchars($options['variant'] ?? 'primary') ?>" type="<?= htmlspecialchars($options['type'] ?? 'button') ?>"><?= htmlspecialchars($text) ?></button>
<?php endif; ?>
