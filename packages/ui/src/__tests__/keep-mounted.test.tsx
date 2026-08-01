import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { KeepMounted } from '../components/KeepMounted.js';

function MountCounter({ onMount }: { onMount: () => void }): JSX.Element {
  const mountedRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    onMount();
  }
  return <div data-testid="mount-counter-child">child</div>;
}

describe('KeepMounted', () => {
  it('renders nothing before the first activation', () => {
    const { container } = render(
      <KeepMounted active={false}>
        <div data-testid="content">content</div>
      </KeepMounted>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('mounts children once activated', () => {
    const { queryByTestId, rerender } = render(
      <KeepMounted active={false}>
        <div data-testid="content">content</div>
      </KeepMounted>,
    );
    expect(queryByTestId('content')).not.toBeInTheDocument();

    rerender(
      <KeepMounted active={true}>
        <div data-testid="content">content</div>
      </KeepMounted>,
    );
    expect(queryByTestId('content')).toBeInTheDocument();
  });

  it('never unmounts children again after deactivating, only hides them with CSS', () => {
    const onMount = vi.fn();
    const { queryByTestId, getByTestId, rerender } = render(
      <KeepMounted active={true}>
        <MountCounter onMount={onMount} />
      </KeepMounted>,
    );
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(getByTestId('mount-counter-child')).toBeInTheDocument();

    rerender(
      <KeepMounted active={false}>
        <MountCounter onMount={onMount} />
      </KeepMounted>,
    );
    // Still present in the DOM (not unmounted) -- just hidden.
    const child = queryByTestId('mount-counter-child');
    expect(child).toBeInTheDocument();
    expect(child?.parentElement).toHaveStyle({ display: 'none' });
    // A real unmount+remount would call onMount a second time.
    expect(onMount).toHaveBeenCalledTimes(1);

    rerender(
      <KeepMounted active={true}>
        <MountCounter onMount={onMount} />
      </KeepMounted>,
    );
    expect(getByTestId('mount-counter-child').parentElement).not.toHaveStyle({ display: 'none' });
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it('applies the given className while active without an inline display override', () => {
    const { container } = render(
      <KeepMounted active={true} className="flex min-h-0 flex-1 flex-col">
        <div>content</div>
      </KeepMounted>,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
    expect(wrapper).not.toHaveStyle({ display: 'none' });
  });
});
