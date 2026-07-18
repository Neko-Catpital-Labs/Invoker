import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '../components/primitives/index.js';

describe('Button primitive', () => {
  it('renders a button element by default', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('applies size and variant classes', () => {
    render(<Button size="sm" variant="outline">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('border');
    expect(button.className).toContain('h-7');
  });

  it('renders destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('bg-destructive');
  });
});

describe('Badge primitive', () => {
  it('renders text with default variant', () => {
    render(<Badge>3</Badge>);
    const badge = screen.getByText('3');
    expect(badge.className).toContain('rounded-full');
  });

  it('applies outline variant', () => {
    render(<Badge variant="outline">2</Badge>);
    const badge = screen.getByText('2');
    expect(badge.className).toContain('border-border');
  });
});

describe('Dialog primitive', () => {
  it('opens content on trigger click', async () => {
    const { getByRole, findByRole } = render(
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">Open</button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const trigger = getByRole('button', { name: 'Open' });
    trigger.click();
    const title = await findByRole('heading', { name: 'Confirm' });
    expect(title).toBeVisible();
  });

  it('applies overlayClassName to the dialog overlay', async () => {
    const { getByRole, findByRole, container } = render(
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">Open</button>
        </DialogTrigger>
        <DialogContent overlayClassName="backdrop-blur-none">
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    getByRole('button', { name: 'Open' }).click();
    await findByRole('heading', { name: 'Confirm' });
    const overlay = container.ownerDocument.querySelector('.backdrop-blur-none');
    expect(overlay).not.toBeNull();
  });
});
