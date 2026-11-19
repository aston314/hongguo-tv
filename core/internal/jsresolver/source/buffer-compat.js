// Node Buffer slice is a view, whereas TypedArray.slice copies. The carrier
// modifies slices in place, so this compatibility detail is part of the wire ABI.
Buffer.prototype.slice=function(start,end){
  var n=this.length;start=start==null?0:Math.trunc(start);end=end==null?n:Math.trunc(end);
  start=start<0?Math.max(n+start,0):Math.min(start,n);end=end<0?Math.max(n+end,0):Math.min(end,n);
  var view=new Uint8Array(this.buffer,this.byteOffset+start,Math.max(0,end-start));Object.setPrototypeOf(view,Buffer.prototype);return view;
};
Buffer.prototype.subarray=Buffer.prototype.slice;
Buffer.prototype.copy=function(target,targetStart,sourceStart,sourceEnd){
  targetStart=targetStart||0;sourceStart=sourceStart||0;sourceEnd=sourceEnd==null?this.length:sourceEnd;
  if(targetStart<0||sourceStart<0||sourceEnd<0)throw new RangeError('buffer copy range');
  var n=Math.max(0,Math.min(sourceEnd,this.length)-sourceStart);n=Math.max(0,Math.min(n,target.length-targetStart));
  Uint8Array.prototype.set.call(target,this.subarray(sourceStart,sourceStart+n),Math.min(targetStart,target.length));return n;
};
