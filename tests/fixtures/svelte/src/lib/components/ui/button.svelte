<script lang="ts">
  /** A button that commits an action. */
  interface Props { variant?: 'default' | 'outline'; size?: 'sm' | 'lg'; children?: any }
  let { variant = 'default', size = 'sm', children }: Props = $props();
</script>
<button class="bg-brand">{@render children?.()}</button>
