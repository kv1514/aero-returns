'use client';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export default function Modal({title, children, onClose, wide=false}: {title:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
  const dialog=useRef<HTMLDialogElement>(null),pressedBackdrop=useRef(false);
  // Layout cleanup runs before React removes the <dialog>, so close() still returns focus to whatever opened it.
  useLayoutEffect(()=>{const el=dialog.current,opener=document.activeElement as HTMLElement|null,old=document.body.style.overflow;el?.showModal();document.body.style.overflow='hidden';return()=>{document.body.style.overflow=old;if(el?.open)el.close();if(opener?.isConnected&&document.activeElement===document.body)opener.focus();};},[]);
  // Only a press and release both outside the dialog box close it, so drag-selecting past the edge or using its scrollbar does not.
  const onBackdrop=({target,clientX:x,clientY:y}:{target:EventTarget;clientX:number;clientY:number})=>{const el=dialog.current;if(!el||target!==el)return false;const r=el.getBoundingClientRect();return x<r.left||x>r.right||y<r.top||y>r.bottom;};
  return <dialog ref={dialog} className={`modal ${wide?'wide':''}`} aria-label={title} onCancel={onClose} onPointerDown={e=>{pressedBackdrop.current=onBackdrop(e);}} onClick={e=>{const close=pressedBackdrop.current&&onBackdrop(e);pressedBackdrop.current=false;if(close)onClose();}}><div className="modal-shell"><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={21}/></button></header>{children}</div></dialog>;
}
