<?php
/* Kit: the fixture's components. Each kit_* function renders its template from this folder. */

function kit_button(string $text, array $options = []): string {
    ob_start();
    include __DIR__ . '/button.php';
    return ob_get_clean();
}

function kit_icon_button(string $icon, array $options = []): string {
    ob_start();
    include __DIR__ . '/icon-button.php';
    return ob_get_clean();
}

function kit_badge(string $text, array $options = []): string {
    ob_start();
    include __DIR__ . '/badge.php';
    return ob_get_clean();
}

function kit_pill(string $text, array $options = []): string {
    ob_start();
    include __DIR__ . '/pill.php';
    return ob_get_clean();
}

function kit_alert(string $message, array $options = []): string {
    ob_start();
    include __DIR__ . '/alert.php';
    return ob_get_clean();
}

function kit_modal(string $id, array $options = []): string {
    ob_start();
    include __DIR__ . '/modal.php';
    return ob_get_clean();
}

function kit_card(string $content, array $options = []): string {
    ob_start();
    include __DIR__ . '/card.php';
    return ob_get_clean();
}

function kit_input(string $name, array $options = []): string {
    ob_start();
    include __DIR__ . '/input.php';
    return ob_get_clean();
}

function kit_select(string $name, array $items, array $options = []): string {
    ob_start();
    include __DIR__ . '/select.php';
    return ob_get_clean();
}

function kit_tabs(array $items, array $options = []): string {
    ob_start();
    include __DIR__ . '/tabs.php';
    return ob_get_clean();
}

function kit_empty_state(string $title, array $options = []): string {
    ob_start();
    include __DIR__ . '/empty-state.php';
    return ob_get_clean();
}

function kit_promo_grid(array $items): string {
    ob_start();
    include __DIR__ . '/promo-grid.php';
    return ob_get_clean();
}

function kit_footer(): string {
    ob_start();
    include __DIR__ . '/footer.php';
    return ob_get_clean();
}
