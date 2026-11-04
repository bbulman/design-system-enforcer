<div class="kit-field">
  <label class="kit-field__label" for="<?= htmlspecialchars($name) ?>"><?= htmlspecialchars($options['label'] ?? $name) ?></label>
  <input class="kit-input" id="<?= htmlspecialchars($name) ?>" name="<?= htmlspecialchars($name) ?>" type="<?= htmlspecialchars($options['type'] ?? 'text') ?>">
</div>
